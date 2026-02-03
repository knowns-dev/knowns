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

// Template handlers
export {
	templateTools,
	handleListTemplates,
	handleGetTemplate,
	handleRunTemplate,
	handleCreateTemplate,
} from "./template";

// Unified Search handler
export { searchTools, handleSearch } from "./search";

// Project detection handlers
export {
	projectTools,
	handleDetectProjects,
	handleSetProject,
	handleGetCurrentProject,
	getProjectRoot,
	setProjectRoot,
} from "./project";

// Validate handler
export { validateTools, handleValidate } from "./validate";
