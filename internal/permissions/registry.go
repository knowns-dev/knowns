// Package permissions provides a shared action registry and policy model
// for the Knowns AI permission system.
//
// The registry classifies every MCP tool+action by capability, target, and
// risk level. Both the audit system and the permission guard consume this
// registry as the single source of truth.
package permissions

// Capability classes for AI actions.
const (
	CapRead     = "read"
	CapWrite    = "write"
	CapGenerate = "generate"
	CapArchive  = "archive"
	CapDelete   = "delete"
	CapAdmin    = "admin"
)

// Target types for AI actions.
const (
	TargetTask     = "task"
	TargetDoc      = "doc"
	TargetMemory   = "memory"
	TargetTemplate = "template"
	TargetTime     = "time"
	TargetImport   = "import"
	TargetRuntime  = "runtime"
	TargetGraph    = "graph"
	TargetSearch   = "search"
	TargetCode     = "code"
)

// Risk levels for AI actions.
const (
	RiskLow    = "low"
	RiskMedium = "medium"
	RiskHigh   = "high"
)

// ActionMeta classifies a single tool+action combination.
type ActionMeta struct {
	Capability string // read, write, generate, delete, archive, admin
	Target     string // task, doc, memory, template, time, search, code, runtime
	Risk       string // low, medium, high
}

// ActionRegistry maps "tool.action" keys to their ActionMeta classification.
// This is the single source of truth consumed by both audit and permission systems.
var ActionRegistry = map[string]ActionMeta{
	// project
	"project.detect":  {Capability: CapRead, Target: TargetRuntime, Risk: RiskLow},
	"project.current": {Capability: CapRead, Target: TargetRuntime, Risk: RiskLow},
	"project.set":     {Capability: CapAdmin, Target: TargetRuntime, Risk: RiskMedium},
	"project.status":  {Capability: CapRead, Target: TargetRuntime, Risk: RiskLow},

	// tasks
	"tasks.create":          {Capability: CapWrite, Target: TargetTask, Risk: RiskMedium},
	"tasks.get":             {Capability: CapRead, Target: TargetTask, Risk: RiskLow},
	"tasks.update":          {Capability: CapWrite, Target: TargetTask, Risk: RiskMedium},
	"tasks.delete":          {Capability: CapDelete, Target: TargetTask, Risk: RiskHigh},
	"tasks.list":            {Capability: CapRead, Target: TargetTask, Risk: RiskLow},
	"tasks.history":         {Capability: CapRead, Target: TargetTask, Risk: RiskLow},
	"tasks.board":           {Capability: CapRead, Target: TargetTask, Risk: RiskLow},
	"tasks.archive":         {Capability: CapArchive, Target: TargetTask, Risk: RiskMedium},
	"tasks.unarchive":       {Capability: CapArchive, Target: TargetTask, Risk: RiskMedium},
	"tasks.batch_archive":   {Capability: CapArchive, Target: TargetTask, Risk: RiskMedium},
	"tasks.batch_unarchive": {Capability: CapArchive, Target: TargetTask, Risk: RiskMedium},
	"tasks.hard_delete":     {Capability: CapDelete, Target: TargetTask, Risk: RiskHigh},

	// docs
	"docs.create":  {Capability: CapWrite, Target: TargetDoc, Risk: RiskMedium},
	"docs.get":     {Capability: CapRead, Target: TargetDoc, Risk: RiskLow},
	"docs.update":  {Capability: CapWrite, Target: TargetDoc, Risk: RiskMedium},
	"docs.delete":  {Capability: CapDelete, Target: TargetDoc, Risk: RiskHigh},
	"docs.list":    {Capability: CapRead, Target: TargetDoc, Risk: RiskLow},
	"docs.history": {Capability: CapRead, Target: TargetDoc, Risk: RiskLow},

	// memory
	"memory.add":     {Capability: CapWrite, Target: TargetMemory, Risk: RiskMedium},
	"memory.get":     {Capability: CapRead, Target: TargetMemory, Risk: RiskLow},
	"memory.update":  {Capability: CapWrite, Target: TargetMemory, Risk: RiskMedium},
	"memory.delete":  {Capability: CapDelete, Target: TargetMemory, Risk: RiskHigh},
	"memory.list":    {Capability: CapRead, Target: TargetMemory, Risk: RiskLow},
	"memory.promote": {Capability: CapWrite, Target: TargetMemory, Risk: RiskMedium},
	"memory.demote":  {Capability: CapWrite, Target: TargetMemory, Risk: RiskMedium},

	// time
	"time.start":  {Capability: CapWrite, Target: TargetTime, Risk: RiskLow},
	"time.stop":   {Capability: CapWrite, Target: TargetTime, Risk: RiskLow},
	"time.add":    {Capability: CapWrite, Target: TargetTime, Risk: RiskMedium},
	"time.report": {Capability: CapRead, Target: TargetTime, Risk: RiskLow},

	// search
	"search.search":   {Capability: CapRead, Target: TargetSearch, Risk: RiskLow},
	"search.retrieve": {Capability: CapRead, Target: TargetSearch, Risk: RiskLow},
	"search.resolve":  {Capability: CapRead, Target: TargetSearch, Risk: RiskLow},

	// code
	"code.search":  {Capability: CapRead, Target: TargetCode, Risk: RiskLow},
	"code.symbols": {Capability: CapRead, Target: TargetCode, Risk: RiskLow},
	"code.deps":    {Capability: CapRead, Target: TargetCode, Risk: RiskLow},
	"code.graph":   {Capability: CapRead, Target: TargetCode, Risk: RiskLow},

	// templates
	"templates.create": {Capability: CapWrite, Target: TargetTemplate, Risk: RiskMedium},
	"templates.get":    {Capability: CapRead, Target: TargetTemplate, Risk: RiskLow},
	"templates.list":   {Capability: CapRead, Target: TargetTemplate, Risk: RiskLow},
	"templates.run":    {Capability: CapGenerate, Target: TargetTemplate, Risk: RiskMedium},

	// validate
	"validate.default": {Capability: CapRead, Target: TargetRuntime, Risk: RiskLow},
	"validate.fix":     {Capability: CapWrite, Target: TargetRuntime, Risk: RiskMedium},
}

// toolFallback provides default classification at the tool level when no
// specific tool.action entry exists.
var toolFallback = map[string]ActionMeta{
	"tasks":     {Capability: CapRead, Target: TargetTask, Risk: RiskLow},
	"docs":      {Capability: CapRead, Target: TargetDoc, Risk: RiskLow},
	"time":      {Capability: CapRead, Target: TargetTime, Risk: RiskLow},
	"search":    {Capability: CapRead, Target: TargetSearch, Risk: RiskLow},
	"code":      {Capability: CapRead, Target: TargetCode, Risk: RiskLow},
	"templates": {Capability: CapRead, Target: TargetTemplate, Risk: RiskLow},
	"validate":  {Capability: CapRead, Target: TargetRuntime, Risk: RiskLow},
	"memory":    {Capability: CapRead, Target: TargetMemory, Risk: RiskLow},
	"project":   {Capability: CapAdmin, Target: TargetRuntime, Risk: RiskMedium},
}

// defaultMeta is returned when no classification is found.
var defaultMeta = ActionMeta{Capability: CapRead, Target: TargetRuntime, Risk: RiskLow}

// ClassifyAction returns the ActionMeta for a tool+action combination.
// It checks the full "tool.action" key first, then falls back to tool-level
// defaults, and finally returns a safe read default.
func ClassifyAction(tool, action string) ActionMeta {
	key := tool + "." + action
	if meta, ok := ActionRegistry[key]; ok {
		return meta
	}
	if meta, ok := toolFallback[tool]; ok {
		return meta
	}
	return defaultMeta
}

// ClassifyValidateAction returns the ActionMeta for a validate call,
// using the fix parameter to distinguish read-only vs write operations.
func ClassifyValidateAction(fix bool) ActionMeta {
	if fix {
		return ActionRegistry["validate.fix"]
	}
	return ActionRegistry["validate.default"]
}
