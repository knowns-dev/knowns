---
title: Context Pattern
createdAt: '2025-12-29T09:01:30.859Z'
updatedAt: '2025-12-29T09:03:35.271Z'
description: Guide for creating React Context in Knowns UI project
tags:
  - patterns
  - react
  - context
  - guide
---
## Overview

Use React Context when you need to share state/data across multiple components without prop drilling.

## When to Use Context?

| Use Case | Use Context? |
|----------|--------------|
| App-wide config/settings | ✅ Yes |
| Theme (dark/light mode) | ✅ Yes |
| User authentication | ✅ Yes |
| Data used by only 2-3 components | ❌ No, use props |
| Frequently changing data | ❌ No, use state management lib |

## Directory Structure

```
src/ui/contexts/
├── ConfigContext.tsx
├── UserContext.tsx
└── ThemeContext.tsx
```

## Template

### 1. Create Context File

```typescript
// src/ui/contexts/ConfigContext.tsx
import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import { getConfig, saveConfig } from "../api/client";

// 1. Define types
interface Config {
  name: string;
  defaultPriority: string;
  defaultLabels: string[];
  visibleColumns: string[];
  // ... other config fields
}

interface ConfigContextType {
  config: Config | null;
  loading: boolean;
  error: Error | null;
  updateConfig: (updates: Partial<Config>) => Promise<void>;
  refetch: () => Promise<void>;
}

// 2. Create context with undefined default
const ConfigContext = createContext<ConfigContextType | undefined>(undefined);

// 3. Default config values
const DEFAULT_CONFIG: Config = {
  name: "Knowns",
  defaultPriority: "medium",
  defaultLabels: [],
  visibleColumns: ["todo", "in-progress", "done"],
};

// 4. Provider component
export function ConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  // Fetch config on mount
  const fetchConfig = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await getConfig();
      setConfig({ ...DEFAULT_CONFIG, ...data } as Config);
    } catch (err) {
      setError(err instanceof Error ? err : new Error("Failed to fetch config"));
      setConfig(DEFAULT_CONFIG); // Fallback to defaults
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchConfig();
  }, []);

  // Update config with optimistic update
  const updateConfig = async (updates: Partial<Config>) => {
    if (\!config) return;
    
    const prevConfig = config;
    const newConfig = { ...config, ...updates };
    setConfig(newConfig); // Optimistic update
    
    try {
      await saveConfig(newConfig);
    } catch (err) {
      setConfig(prevConfig); // Rollback on error
      throw err;
    }
  };

  return (
    <ConfigContext.Provider
      value={{
        config,
        loading,
        error,
        updateConfig,
        refetch: fetchConfig,
      }}
    >
      {children}
    </ConfigContext.Provider>
  );
}

// 5. Custom hook with error handling
export function useConfig() {
  const context = useContext(ConfigContext);
  if (context === undefined) {
    throw new Error("useConfig must be used within a ConfigProvider");
  }
  return context;
}

// 6. Optional: Hook for specific config value
export function useConfigValue<K extends keyof Config>(key: K): Config[K] | undefined {
  const { config } = useConfig();
  return config?.[key];
}
```

### 2. Wrap App with Provider

```typescript
// src/ui/App.tsx
import { ConfigProvider } from "./contexts/ConfigContext";
import { UserProvider } from "./contexts/UserContext";

export default function App() {
  return (
    <ConfigProvider>
      <UserProvider>
        {/* App content */}
      </UserProvider>
    </ConfigProvider>
  );
}
```

### 3. Use in Components

```typescript
// Before (❌ Direct API call)
import { getConfig } from "../api/client";

function MyComponent() {
  const [config, setConfig] = useState(null);
  
  useEffect(() => {
    getConfig().then(setConfig); // ❌ Each component calls separately
  }, []);
  
  return <div>{config?.name}</div>;
}

// After (✅ Use Context)
import { useConfig } from "../contexts/ConfigContext";

function MyComponent() {
  const { config, loading } = useConfig(); // ✅ Shared state
  
  if (loading) return <Skeleton />;
  return <div>{config?.name}</div>;
}
```

## Best Practices

### DO ✅

- Fetch data once at Provider level
- Provide loading and error states
- Have default values to avoid null checks
- Separate concerns (Config, User, Theme)
- Use optimistic updates for better UX

### DON'T ❌

- Put all state in one large context
- Skip error handling
- Forget cleanup in useEffect
- Nest too many providers (max 3-4)
- Store frequently changing data in context

## Provider Order

Provider order matters - outer providers can be used by inner ones:

```typescript
<ConfigProvider>      {/* Outer: no dependencies */}
  <ThemeProvider>     {/* Can use config */}
    <UserProvider>    {/* Can use config + theme */}
      <App />
    </UserProvider>
  </ThemeProvider>
</ConfigProvider>
```

## Testing

```typescript
// Mock provider for tests
export function MockConfigProvider({ 
  children,
  config = DEFAULT_CONFIG 
}: { 
  children: ReactNode;
  config?: Partial<Config>;
}) {
  return (
    <ConfigContext.Provider
      value={{
        config: { ...DEFAULT_CONFIG, ...config },
        loading: false,
        error: null,
        updateConfig: async () => {},
        refetch: async () => {},
      }}
    >
      {children}
    </ConfigContext.Provider>
  );
}

// Usage in test
render(
  <MockConfigProvider config={{ name: "Test Project" }}>
    <MyComponent />
  </MockConfigProvider>
);
```

## Related

- [removed [removed [removed ~task-58]]] - Create ConfigContext implementation
- `src/ui/contexts/UserContext.tsx` - Existing example
