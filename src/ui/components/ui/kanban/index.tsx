'use client';

import type {
  Announcements,
  CollisionDetection,
  DndContextProps,
  DragEndEvent,
  DragOverEvent,
  DragStartEvent,
} from '@dnd-kit/core';
import {
  closestCenter,
  closestCorners,
  DndContext,
  DragOverlay,
  getFirstCollision,
  KeyboardSensor,
  MouseSensor,
  pointerWithin,
  rectIntersection,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { arrayMove, SortableContext, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  createContext,
  type HTMLAttributes,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import tunnel from 'tunnel-rat';
import { Card } from '@/ui/components/ui/card';
import { ScrollArea, ScrollBar } from '@/ui/components/ui/scroll-area';
import { cn } from '@/ui/lib/utils';
import { useIsMobile } from '@/ui/hooks/use-mobile';

const t = tunnel();

export type { DragEndEvent } from '@dnd-kit/core';

type KanbanItemProps = {
  id: string;
  name: string;
  column: string;
} & Record<string, unknown>;

type KanbanColumnProps = {
  id: string;
  name: string;
} & Record<string, unknown>;

type KanbanContextProps<
  T extends KanbanItemProps = KanbanItemProps,
  C extends KanbanColumnProps = KanbanColumnProps,
> = {
  columns: C[];
  data: T[];
  activeCardId: string | null;
};

const KanbanContext = createContext<KanbanContextProps>({
  columns: [],
  data: [],
  activeCardId: null,
});

export type KanbanBoardProps = {
  id: string;
  children: ReactNode;
  className?: string;
};

export const KanbanBoard = ({ id, children, className }: KanbanBoardProps) => {
  const { isOver, setNodeRef } = useDroppable({
    id,
  });

  return (
    <div
      className={cn(
        'flex min-h-40 flex-col divide-y overflow-hidden rounded-md border bg-secondary text-xs shadow-sm ring-2 transition-all shrink-0',
        isOver ? 'ring-primary' : 'ring-transparent',
        className
      )}
      ref={setNodeRef}
    >
      {children}
    </div>
  );
};

export type KanbanCardProps<T extends KanbanItemProps = KanbanItemProps> = T & {
  children?: ReactNode;
  className?: string;
};

export const KanbanCard = <T extends KanbanItemProps = KanbanItemProps>({
  id,
  name,
  children,
  className,
}: KanbanCardProps<T>) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transition,
    transform,
    isDragging,
  } = useSortable({
    id,
  });
  const { activeCardId } = useContext(KanbanContext) as KanbanContextProps;

  const style = {
    transition,
    transform: CSS.Transform.toString(transform),
  };

  return (
    <>
      <div style={style} {...listeners} {...attributes} ref={setNodeRef}>
        <Card
          className={cn(
            'cursor-grab gap-4 rounded-md p-3 shadow-sm',
            isDragging && 'pointer-events-none cursor-grabbing opacity-30',
            className
          )}
        >
          {children ?? <p className="m-0 font-medium text-sm">{name}</p>}
        </Card>
      </div>
      {activeCardId === id && (
        <t.In>
          <Card
            className={cn(
              'cursor-grab gap-4 rounded-md p-3 shadow-sm ring-2 ring-primary',
              isDragging && 'cursor-grabbing',
              className
            )}
          >
            {children ?? <p className="m-0 font-medium text-sm">{name}</p>}
          </Card>
        </t.In>
      )}
    </>
  );
};

export type KanbanCardsProps<T extends KanbanItemProps = KanbanItemProps> =
  Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'id'> & {
    children: (item: T) => ReactNode;
    id: string;
  };

export const KanbanCards = <T extends KanbanItemProps = KanbanItemProps>({
  children,
  className,
  ...props
}: KanbanCardsProps<T>) => {
  const { data } = useContext(KanbanContext) as KanbanContextProps<T>;
  const filteredData = data.filter((item) => item.column === props.id);
  const items = filteredData.map((item) => item.id);

  return (
    <ScrollArea className="overflow-hidden flex-1">
      <SortableContext items={items}>
        <div
          className={cn('flex flex-grow flex-col gap-2 p-2', className)}
          {...(props as any)}
        >
          {filteredData.map(children)}
        </div>
      </SortableContext>
      <ScrollBar orientation="vertical" />
    </ScrollArea>
  );
};

export type KanbanHeaderProps = HTMLAttributes<HTMLDivElement>;

export const KanbanHeader = ({ className, ...props }: KanbanHeaderProps) => (
  <div className={cn('m-0 p-2 font-semibold text-sm', className)} {...(props as any)} />
);

// Custom collision detection that works with both sortable cards and empty droppable columns
// This algorithm is optimized for kanban boards with multi-strategy detection
const createCustomCollisionDetection = (columnIds: string[]): CollisionDetection => {
  return (args) => {
    const { droppableRects, droppableContainers, pointerCoordinates } = args;

    // Helper to check if collision is a card (not a column)
    const isCard = (id: string | number) => !columnIds.includes(id as string);
    const isColumn = (id: string | number) => columnIds.includes(id as string);

    // Strategy 1: Check pointer position first (most intuitive for users)
    const pointerCollisions = pointerWithin(args);
    const pointerOverCards = pointerCollisions.filter(c => isCard(c.id));
    const pointerOverColumns = pointerCollisions.filter(c => isColumn(c.id));

    // If pointer is directly over cards, use closestCorners for precise positioning
    if (pointerOverCards.length > 0) {
      const cornersCollisions = closestCorners(args);
      const cardCorners = cornersCollisions.filter(c => isCard(c.id));
      if (cardCorners.length > 0) {
        return [cardCorners[0]];
      }
      return [pointerOverCards[0]];
    }

    // If pointer is over a column (empty area), return that column immediately
    if (pointerOverColumns.length > 0) {
      return [pointerOverColumns[0]];
    }

    // Strategy 2: Use rectIntersection for when dragged item overlaps targets
    const rectCollisions = rectIntersection(args);
    const rectOverCards = rectCollisions.filter(c => isCard(c.id));
    const rectOverColumns = rectCollisions.filter(c => isColumn(c.id));

    if (rectOverCards.length > 0) {
      // Use closestCenter among intersecting cards
      const centerCollisions = closestCenter(args);
      const cardCenter = centerCollisions.filter(c => isCard(c.id));
      if (cardCenter.length > 0) {
        return [cardCenter[0]];
      }
      return [rectOverCards[0]];
    }

    if (rectOverColumns.length > 0) {
      return [rectOverColumns[0]];
    }

    // Strategy 3: Find closest column by distance (for when dragging near but not over)
    // This makes it easier to drop into columns even when slightly outside
    if (pointerCoordinates) {
      let closestColumn: { id: string; distance: number } | null = null;

      for (const columnId of columnIds) {
        const rect = droppableRects.get(columnId);
        if (!rect) continue;

        // Calculate distance from pointer to column center
        const columnCenterX = rect.left + rect.width / 2;
        const columnCenterY = rect.top + rect.height / 2;
        const distance = Math.sqrt(
          Math.pow(pointerCoordinates.x - columnCenterX, 2) +
          Math.pow(pointerCoordinates.y - columnCenterY, 2)
        );

        // Check if pointer is within extended bounds (150px buffer)
        const extendedBounds = {
          left: rect.left - 150,
          right: rect.right + 150,
          top: rect.top - 50,
          bottom: rect.bottom + 50,
        };

        const isNearColumn =
          pointerCoordinates.x >= extendedBounds.left &&
          pointerCoordinates.x <= extendedBounds.right &&
          pointerCoordinates.y >= extendedBounds.top &&
          pointerCoordinates.y <= extendedBounds.bottom;

        if (isNearColumn && (!closestColumn || distance < closestColumn.distance)) {
          closestColumn = { id: columnId, distance };
        }
      }

      if (closestColumn) {
        return [{ id: closestColumn.id }];
      }
    }

    // Strategy 4: Ultimate fallback - closest corners to anything
    const fallbackCollisions = closestCorners(args);
    if (fallbackCollisions.length > 0) {
      // Prefer columns over cards in fallback
      const fallbackColumn = fallbackCollisions.find(c => isColumn(c.id));
      if (fallbackColumn) {
        return [fallbackColumn];
      }
      return [fallbackCollisions[0]];
    }

    return [];
  };
};

export type KanbanProviderProps<
  T extends KanbanItemProps = KanbanItemProps,
  C extends KanbanColumnProps = KanbanColumnProps,
> = Omit<DndContextProps, 'children'> & {
  children: (column: C) => ReactNode;
  className?: string;
  columns: C[];
  data: T[];
  onDataChange?: (data: T[]) => void;
  onDragStart?: (event: DragStartEvent) => void;
  onDragEnd?: (event: DragEndEvent) => void;
  onDragOver?: (event: DragOverEvent) => void;
};

export const KanbanProvider = <
  T extends KanbanItemProps = KanbanItemProps,
  C extends KanbanColumnProps = KanbanColumnProps,
>({
  children,
  onDragStart,
  onDragEnd,
  onDragOver,
  className,
  columns,
  data,
  onDataChange,
  ...props
}: KanbanProviderProps<T, C>) => {
  const [activeCardId, setActiveCardId] = useState<string | null>(null);
  const isMobile = useIsMobile();

  // Create column IDs array for collision detection
  const columnIds = useMemo(() => columns.map(col => col.id), [columns]);

  // Create custom collision detection that handles empty columns
  const collisionDetection = useMemo(
    () => createCustomCollisionDetection(columnIds),
    [columnIds]
  );

  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: {
        distance: 8, // Require 8px movement before drag starts (allows clicks)
      },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 150, // Slightly shorter delay for better mobile responsiveness
        tolerance: 8, // More tolerance for finger movement
      },
    }),
    useSensor(KeyboardSensor)
  );

  const handleDragStart = (event: DragStartEvent) => {
    const card = data.find((item) => item.id === event.active.id);
    if (card) {
      setActiveCardId(event.active.id as string);
    }
    onDragStart?.(event);
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event;

    if (!over) {
      return;
    }

    const activeItem = data.find((item) => item.id === active.id);
    const overItem = data.find((item) => item.id === over.id);

    if (!(activeItem)) {
      return;
    }

    const activeColumn = activeItem.column;
    // Check if dropping on a column (empty or not) or on a card
    const isOverColumn = columns.some(col => col.id === over.id);
    const overColumn = isOverColumn
      ? over.id as string
      : overItem?.column || activeColumn;

    if (activeColumn !== overColumn) {
      let newData = [...data];
      const activeIndex = newData.findIndex((item) => item.id === active.id);

      // Update the column first
      newData[activeIndex] = { ...newData[activeIndex], column: overColumn };

      // If dropping on a card, reorder; if dropping on empty column, just move to end of that column's items
      if (overItem) {
        const overIndex = newData.findIndex((item) => item.id === over.id);
        newData = arrayMove(newData, activeIndex, overIndex);
      }

      onDataChange?.(newData);
    }

    onDragOver?.(event);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveCardId(null);

    onDragEnd?.(event);

    const { active, over } = event;

    if (!over || active.id === over.id) {
      return;
    }

    // Check if dropping on a column (empty or with items)
    const isOverColumn = columns.some(col => col.id === over.id);

    if (isOverColumn) {
      // Dropped on a column - the column change was already handled in handleDragOver
      // Just ensure the item is in the correct column
      const activeItem = data.find((item) => item.id === active.id);
      if (activeItem && activeItem.column !== over.id) {
        let newData = [...data];
        const activeIndex = newData.findIndex((item) => item.id === active.id);
        newData[activeIndex] = { ...newData[activeIndex], column: over.id as string };
        onDataChange?.(newData);
      }
      return;
    }

    // Dropping on another card - reorder within or across columns
    let newData = [...data];
    const oldIndex = newData.findIndex((item) => item.id === active.id);
    const newIndex = newData.findIndex((item) => item.id === over.id);

    if (oldIndex !== -1 && newIndex !== -1) {
      newData = arrayMove(newData, oldIndex, newIndex);
      onDataChange?.(newData);
    }
  };

  const announcements: Announcements = {
    onDragStart({ active }) {
      const { name, column } = data.find((item) => item.id === active.id) ?? {};

      return `Picked up the card "${name}" from the "${column}" column`;
    },
    onDragOver({ active, over }) {
      const { name } = data.find((item) => item.id === active.id) ?? {};
      const newColumn = columns.find((column) => column.id === over?.id)?.name;

      return `Dragged the card "${name}" over the "${newColumn}" column`;
    },
    onDragEnd({ active, over }) {
      const { name } = data.find((item) => item.id === active.id) ?? {};
      const newColumn = columns.find((column) => column.id === over?.id)?.name;

      return `Dropped the card "${name}" into the "${newColumn}" column`;
    },
    onDragCancel({ active }) {
      const { name } = data.find((item) => item.id === active.id) ?? {};

      return `Cancelled dragging the card "${name}"`;
    },
  };

  return (
    <KanbanContext.Provider value={{ columns, data, activeCardId }}>
      <DndContext
        accessibility={{ announcements }}
        collisionDetection={collisionDetection}
        onDragEnd={handleDragEnd}
        onDragOver={handleDragOver}
        onDragStart={handleDragStart}
        sensors={sensors}
        {...(props as any)}
      >
        <div
          className={cn(
            'flex gap-4',
            // Stack columns vertically on mobile for better scrolling
            isMobile && 'flex-col',
            className
          )}
        >
          {columns.map((column) => children(column))}
        </div>
        {typeof window !== 'undefined' &&
          createPortal(
            <DragOverlay>
              <t.Out />
            </DragOverlay>,
            document.body
          )}
      </DndContext>
    </KanbanContext.Provider>
  );
};