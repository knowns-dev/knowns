/**
 * Route aggregator - combines all route modules
 */

import { Router } from "express";
import type { RouteContext } from "../types";
import { createActivityRoutes } from "./activities";
import { createConfigRoutes } from "./config";
import { createDocRoutes } from "./docs";
import { createImportRoutes } from "./imports";
import { createNotifyRoutes } from "./notify";
import { createSearchRoutes } from "./search";
import { createTaskRoutes } from "./tasks";
import { createTemplateRoutes } from "./templates";
import { createTimeRoutes } from "./time";
import { createValidateRoutes } from "./validate";

export function createRoutes(ctx: RouteContext): Router {
	const router = Router();

	router.use("/tasks", createTaskRoutes(ctx));
	router.use("/docs", createDocRoutes(ctx));
	router.use("/templates", createTemplateRoutes(ctx));
	router.use("/config", createConfigRoutes(ctx));
	router.use("/search", createSearchRoutes(ctx));
	router.use("/activities", createActivityRoutes(ctx));
	router.use("/notify", createNotifyRoutes(ctx));
	router.use("/time", createTimeRoutes(ctx));
	router.use("/imports", createImportRoutes(ctx));
	router.use("/validate", createValidateRoutes(ctx));

	return router;
}
