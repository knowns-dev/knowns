package tasklifecycle

import (
	"fmt"
	"strings"
)

type FailureKind string

const (
	FailureNone           FailureKind = ""
	FailureInvalidRequest FailureKind = "invalid_request"
	FailurePermission     FailureKind = "permission_denied"
	FailureNotFound       FailureKind = "not_found"
	FailureConflict       FailureKind = "conflict"
	FailureDenied         FailureKind = "business_denied"
	FailureOperation      FailureKind = "operation_failed"
)

// ContractError is the single public failure classification used by CLI,
// MCP, and HTTP adapters after a lifecycle Response has been built.
type ContractError struct {
	Kind  FailureKind
	Cause error
}

func (err *ContractError) Error() string {
	if err == nil {
		return ""
	}
	if err.Cause != nil {
		return err.Cause.Error()
	}
	return string(err.Kind)
}

func (err *ContractError) Unwrap() error {
	if err == nil {
		return nil
	}
	return err.Cause
}

// FailureKindFor deterministically classifies a response. Preview eligibility
// reasons are informational; execute-time denials are failures. Idempotent
// already_* reasons remain successful on both paths.
func FailureKindFor(response *Response, cause error) FailureKind {
	if response == nil {
		return FailureOperation
	}
	best := FailureNone
	for _, item := range response.Items {
		for _, reason := range item.Reasons {
			kind := failureKindForReason(reason.Code, response.Execute)
			if failurePriority(kind) > failurePriority(best) {
				best = kind
			}
		}
	}
	if best != FailureNone {
		return best
	}
	if cause != nil {
		return FailureOperation
	}
	return FailureNone
}

func contractError(response *Response, cause error) error {
	kind := FailureKindFor(response, cause)
	if kind == FailureNone {
		return nil
	}
	if cause == nil {
		cause = fmt.Errorf("Task lifecycle request failed: %s", kind)
	}
	return &ContractError{Kind: kind, Cause: cause}
}

func failureKindForReason(code ReasonCode, execute bool) FailureKind {
	switch code {
	case ReasonInvalidRequest, ReasonConfirmationRequired, ReasonDeleteReasonRequired:
		return FailureInvalidRequest
	case ReasonPermissionRequired:
		return FailurePermission
	case ReasonNotFound:
		return FailureNotFound
	case ReasonTombstoneConflict:
		return FailureConflict
	case ReasonOperationFailed:
		return FailureOperation
	case ReasonAlreadyArchived, ReasonAlreadyActive, ReasonAlreadyDeleted:
		return FailureNone
	default:
		if execute {
			return FailureDenied
		}
		return FailureNone
	}
}

func failurePriority(kind FailureKind) int {
	switch kind {
	case FailurePermission:
		return 6
	case FailureInvalidRequest:
		return 5
	case FailureNotFound:
		return 4
	case FailureConflict:
		return 3
	case FailureDenied:
		return 2
	case FailureOperation:
		return 1
	default:
		return 0
	}
}

func validatePublicRequest(request Request) *Reason {
	invalid := func(message string) *Reason {
		return &Reason{Code: ReasonInvalidRequest, Message: message}
	}
	switch request.Operation {
	case OperationArchive, OperationReopen, OperationHardDelete:
		if strings.TrimSpace(request.TaskID) == "" {
			return invalid("taskId is required")
		}
	case OperationBatchArchive:
		for _, id := range request.IDs {
			if strings.TrimSpace(id) == "" {
				return invalid("batch Task IDs must be non-empty")
			}
		}
	case OperationBatchUnarchive:
		if len(request.IDs) == 0 {
			return invalid("ids must contain at least one Task ID")
		}
		for _, id := range request.IDs {
			if strings.TrimSpace(id) == "" {
				return invalid("batch Task IDs must be non-empty")
			}
		}
	default:
		return invalid(fmt.Sprintf("unsupported Task lifecycle operation %q", request.Operation))
	}
	return nil
}
