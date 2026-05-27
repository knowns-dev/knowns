package search

import "fmt"

// ErrSemanticRuntimeUnavailable is returned when the ONNX runtime library is unavailable.
var ErrSemanticRuntimeUnavailable = fmt.Errorf("semantic search is unavailable: ONNX runtime shared library not found")
