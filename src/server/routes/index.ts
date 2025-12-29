/**
 * Route aggregator - combines all route modules
 */

import { Router } from "express";
import type { RouteContext } from "../types";
import { createActivityRoutes } from "./activities";
import { createConfigRoutes } from "./config";
import { createDocRoutes } from "./docs";
import { createNotifyRoutes } from "./notify";
import { createSearchRoutes } from "./search";
import { createTaskRoutes } from "./tasks";
import { createTimeRoutes } from "./time";

export function createRoutes(ctx: RouteContext): Router {
	const router = Router();

	router.use("/tasks", createTaskRoutes(ctx));
	router.use("/docs", createDocRoutes(ctx));
	router.use("/config", createConfigRoutes(ctx));
	router.use("/search", createSearchRoutes(ctx));
	router.use("/activities", createActivityRoutes(ctx));
	router.use("/notify", createNotifyRoutes(ctx));
	router.use("/time", createTimeRoutes(ctx));

	return router;
}
