package handlers

import (
	"fmt"
	"math"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// stringArg safely extracts a string argument from the args map.
// Text fields are stored verbatim: JSON already carries real newlines, so
// rewriting literal \n and \t would only corrupt genuine backslash sequences
// such as code snippets, regexes, and Windows paths.
func stringArg(args map[string]any, key string) (string, bool) {
	v, ok := args[key]
	if !ok {
		return "", false
	}
	s, ok := v.(string)
	return s, ok
}

const (
	mutationReturnSummary = "summary"
	mutationReturnFull    = "full"
)

func parseMutationReturn(args map[string]any) (string, error) {
	value, exists := args["return"]
	if !exists {
		return mutationReturnSummary, nil
	}
	mode, ok := value.(string)
	if !ok || (mode != mutationReturnSummary && mode != mutationReturnFull) {
		return "", fmt.Errorf("invalid return value %v; valid values are %q and %q", value, mutationReturnSummary, mutationReturnFull)
	}
	return mode, nil
}

// intArg safely extracts an int argument from the args map (JSON numbers come as float64).
func intArg(args map[string]any, key string) (int, bool) {
	v, ok := args[key]
	if !ok {
		return 0, false
	}
	switch n := v.(type) {
	case float64:
		return int(n), true
	case int:
		return n, true
	case int64:
		return int(n), true
	}
	return 0, false
}

func historyPageArgs(args map[string]any) (int, int, error) {
	parse := func(key string) (int, error) {
		value, exists := args[key]
		if !exists {
			return 0, nil
		}
		var result int
		switch number := value.(type) {
		case float64:
			if math.IsNaN(number) || math.IsInf(number, 0) || number < 0 || math.Trunc(number) != number || number > float64(int(^uint(0)>>1)) {
				return 0, fmt.Errorf("%s must be a non-negative integer", key)
			}
			result = int(number)
		case int:
			result = number
		case int64:
			if number > int64(int(^uint(0)>>1)) {
				return 0, fmt.Errorf("%s must be a non-negative integer", key)
			}
			result = int(number)
		default:
			return 0, fmt.Errorf("%s must be a non-negative integer", key)
		}
		if result < 0 {
			return 0, fmt.Errorf("%s must be a non-negative integer", key)
		}
		return result, nil
	}
	offset, err := parse("offset")
	if err != nil {
		return 0, 0, err
	}
	limit, err := parse("limit")
	if err != nil {
		return 0, 0, err
	}
	return offset, limit, nil
}

// boolArg safely extracts a bool from args; returns false if not present.
func boolArg(args map[string]any, key string) bool {
	v, ok := args[key]
	if !ok {
		return false
	}
	b, ok := v.(bool)
	return ok && b
}

// stringSliceArg extracts a []string from an args map value (which may be []any).
func stringSliceArg(args map[string]any, key string) ([]string, bool) {
	v, ok := args[key]
	if !ok {
		return nil, false
	}
	switch arr := v.(type) {
	case []string:
		return arr, true
	case []any:
		result := make([]string, 0, len(arr))
		for _, item := range arr {
			if s, ok := item.(string); ok {
				result = append(result, s)
			}
		}
		return result, true
	}
	return nil, false
}

// stringSetArg extracts a set of strings from an args map value.
func stringSetArg(args map[string]any, key string) map[string]bool {
	values, ok := stringSliceArg(args, key)
	if !ok {
		return nil
	}
	set := make(map[string]bool, len(values))
	for _, value := range values {
		if value != "" {
			set[value] = true
		}
	}
	return set
}

// intSliceArg extracts a []int from an args map value (JSON arrays of numbers come as []any of float64).
func intSliceArg(args map[string]any, key string) ([]int, bool) {
	v, ok := args[key]
	if !ok {
		return nil, false
	}
	switch arr := v.(type) {
	case []int:
		return arr, true
	case []any:
		result := make([]int, 0, len(arr))
		for _, item := range arr {
			switch n := item.(type) {
			case float64:
				result = append(result, int(n))
			case int:
				result = append(result, n)
			}
		}
		return result, true
	}
	return nil, false
}

// containsString checks if a string slice contains a value.
type toolRegistrar interface {
	AddTool(mcp.Tool, server.ToolHandlerFunc)
	RegisterHelp(string, HelpEntry)
}

func registerHelp(s toolRegistrar, key string, entry HelpEntry) {
	s.RegisterHelp(key, entry)
}

func containsString(slice []string, val string) bool {
	for _, s := range slice {
		if s == val {
			return true
		}
	}
	return false
}
