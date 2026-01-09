/**
 * MCP Handlers Index - Export all handlers and tools
 */

// Task handlers
export {
	taskTools,
	handleCreateTask,
	handleGetTask,
	handleUpdateTask,
	handleListTasks,
	handleSearchTasks,
} from "./task";

// Time handlers
export {
	timeTools,
	handleStartTime,
	handleStopTime,
	handleAddTime,
	handleGetTimeReport,
} from "./time";

// Board handlers
export { boardTools, handleGetBoard } from "./board";

// Doc handlers
export {
	docTools,
	handleListDocs,
	handleGetDoc,
	handleCreateDoc,
	handleUpdateDoc,
	handleSearchDocs,
} from "./doc";

// Guideline handlers
export { guidelineTools, handleGetGuideline } from "./guideline";
