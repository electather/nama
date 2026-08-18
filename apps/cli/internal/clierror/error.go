// Package clierror defines the CLI's safe public error contract.
package clierror

import (
	"encoding/json"
	"errors"
	"maps"
	"slices"
	"strings"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/genproto/googleapis/rpc/errdetails"
)

const (
	CodeUnexpectedFailure            = "unexpected_failure"
	CodeInvalidArgument              = "invalid_argument"
	CodeInvalidConfiguration         = "invalid_configuration"
	CodeProfileNotFound              = "profile_not_found"
	CodeCredentialStoreUnavailable   = "credential_store_unavailable"
	CodeCredentialCleanupFailed      = "credential_cleanup_failed"
	CodeUnsafeTransport              = "unsafe_transport"
	CodeNetworkUnavailable           = "network_unavailable"
	CodeAlreadyInitialized           = "already_initialized"
	CodeAuthenticationFailed         = "authentication_failed"
	CodeAuthenticationUnavailable    = "authentication_unavailable"
	CodeCredentialInvalid            = "credential_invalid"
	CodeDeadlineExceeded             = "deadline_exceeded"
	CodeInternal                     = "internal"
	CodeNotInitialized               = "not_initialized"
	CodePermissionDenied             = "permission_denied"
	CodeRateLimited                  = "rate_limited"
	CodeRequestCancelled             = "request_cancelled"
	CodeSessionRevocationUnconfirmed = "session_revocation_unconfirmed"
	CodeSetupInProgress              = "setup_in_progress"
	CodeSetupUnavailable             = "setup_unavailable"
	CodeValidationFailed             = "validation_failed"
	CodeUnknown                      = "unknown"
	CodeCancelled                    = "canceled"
	CodeNotFound                     = "not_found"
	CodeAlreadyExists                = "already_exists"
	CodeResourceExhausted            = "resource_exhausted"
	CodeFailedPrecondition           = "failed_precondition"
	CodeAborted                      = "aborted"
	CodeOutOfRange                   = "out_of_range"
	CodeUnimplemented                = "unimplemented"
	CodeUnavailable                  = "unavailable"
	CodeDataLoss                     = "data_loss"
	CodeUnauthenticated              = "unauthenticated"
)

const (
	apiErrorDomain       = "nama.api.v1"
	requestIDHeader      = "nama-request-id"
	maxFieldViolations   = 50
	maxPublicDescription = 160
	maxRequestIDLength   = 128
)

var messages = map[string]string{
	CodeUnexpectedFailure:            "The request could not be completed.",
	CodeInvalidArgument:              "The request is invalid.",
	CodeInvalidConfiguration:         "The CLI configuration is invalid.",
	CodeProfileNotFound:              "The requested profile was not found.",
	CodeCredentialStoreUnavailable:   "The credential store is unavailable.",
	CodeCredentialCleanupFailed:      "The invalid credential could not be removed.",
	CodeUnsafeTransport:              "The server URL requires secure transport.",
	CodeNetworkUnavailable:           "The server is unavailable.",
	CodeAlreadyInitialized:           "The server is already initialized.",
	CodeAuthenticationFailed:         "Authentication failed.",
	CodeAuthenticationUnavailable:    "Authentication is temporarily unavailable.",
	CodeCredentialInvalid:            "The credential is invalid or expired.",
	CodeDeadlineExceeded:             "The request timed out.",
	CodeInternal:                     "The request could not be completed.",
	CodeNotInitialized:               "The server has not been initialized.",
	CodePermissionDenied:             "Permission was denied.",
	CodeRateLimited:                  "Too many requests. Try again later.",
	CodeRequestCancelled:             "The request was cancelled.",
	CodeSessionRevocationUnconfirmed: "The session could not be confirmed as revoked.",
	CodeSetupInProgress:              "Setup is already in progress.",
	CodeSetupUnavailable:             "Setup status is temporarily unavailable.",
	CodeValidationFailed:             "The request is invalid.",
	CodeUnknown:                      "The request could not be completed.",
	CodeCancelled:                    "The request was cancelled.",
	CodeNotFound:                     "The requested resource was not found.",
	CodeAlreadyExists:                "The resource already exists.",
	CodeResourceExhausted:            "The server is temporarily unavailable.",
	CodeFailedPrecondition:           "The request cannot be completed in the current state.",
	CodeAborted:                      "The request could not be completed at this time.",
	CodeOutOfRange:                   "The request is invalid.",
	CodeUnimplemented:                "The requested operation is not available.",
	CodeUnavailable:                  "The server is unavailable.",
	CodeDataLoss:                     "The request could not be completed.",
	CodeUnauthenticated:              "Authentication is required.",
}

var reasonCodes = map[string]string{
	"ALREADY_INITIALIZED":            CodeAlreadyInitialized,
	"AUTHENTICATION_FAILED":          CodeAuthenticationFailed,
	"AUTHENTICATION_UNAVAILABLE":     CodeAuthenticationUnavailable,
	"CREDENTIAL_INVALID":             CodeCredentialInvalid,
	"DEADLINE_EXCEEDED":              CodeDeadlineExceeded,
	"INTERNAL":                       CodeInternal,
	"NOT_INITIALIZED":                CodeNotInitialized,
	"PERMISSION_DENIED":              CodePermissionDenied,
	"RATE_LIMITED":                   CodeRateLimited,
	"REQUEST_CANCELLED":              CodeRequestCancelled,
	"SESSION_REVOCATION_UNCONFIRMED": CodeSessionRevocationUnconfirmed,
	"SETUP_IN_PROGRESS":              CodeSetupInProgress,
	"SETUP_UNAVAILABLE":              CodeSetupUnavailable,
	"VALIDATION_FAILED":              CodeValidationFailed,
}

var fieldReasons = map[string]struct{}{
	"required":          {},
	"invalid_format":    {},
	"out_of_range":      {},
	"unsupported_value": {},
	"mismatch":          {},
	"conflict":          {},
}

var fieldDescriptions = map[string]struct{}{
	"is required":                           {},
	"has an invalid format":                 {},
	"is outside the permitted range":        {},
	"has an unsupported value":              {},
	"does not match":                        {},
	"conflicts with another value":          {},
	"Use a valid email address.":            {},
	"Enter a supported value.":              {},
	"must be an absolute HTTP or HTTPS URL": {},
	"Enter a valid server URL.":             {},
}

// FieldViolation is a normalized, public validation failure.
type FieldViolation struct {
	Field       string `json:"field"`
	Reason      string `json:"reason"`
	Description string `json:"description"`
}

// Error is the safe CLI error rendered to users. Its cause is intentionally private.
type Error struct {
	Code            string           `json:"code"`
	RequestID       string           `json:"request_id,omitempty"`
	FieldViolations []FieldViolation `json:"field_violations,omitempty"`
	RetryDelay      time.Duration    `json:"retry_delay,omitzero"`

	cause error
}

// Codes returns every stable public error code in canonical order.
func Codes() []string {
	return slices.Sorted(maps.Keys(messages))
}

// New creates a local CLI error from an allowlisted stable code. Unknown codes are unexpected failures.
func New(code string, cause error) *Error {
	code, _ = stableError(code)
	return &Error{Code: code, cause: cause}
}

// Unexpected creates a safe error for an unexpected local failure.
func Unexpected(cause error) *Error {
	return New(CodeUnexpectedFailure, cause)
}

// InvalidArgument creates a safe invalid-argument error.
func InvalidArgument(cause error) *Error {
	return New(CodeInvalidArgument, cause)
}

// InvalidConfiguration creates a safe malformed-configuration error.
func InvalidConfiguration(cause error) *Error {
	return New(CodeInvalidConfiguration, cause)
}

// ProfileNotFound creates a safe missing-profile error.
func ProfileNotFound(cause error) *Error {
	return New(CodeProfileNotFound, cause)
}

// CredentialStoreUnavailable creates a safe credential-store failure.
func CredentialStoreUnavailable(cause error) *Error {
	return New(CodeCredentialStoreUnavailable, cause)
}

// CredentialCleanupFailed creates a safe invalid-credential cleanup error.
func CredentialCleanupFailed(cause error) *Error {
	return New(CodeCredentialCleanupFailed, cause)
}

// UnsafeTransport creates a safe unsafe-server-URL error.
func UnsafeTransport(cause error) *Error {
	return New(CodeUnsafeTransport, cause)
}

// NetworkUnavailable creates a safe local network failure.
func NetworkUnavailable(cause error) *Error {
	return New(CodeNetworkUnavailable, cause)
}

// Error returns the safe public message rather than the private cause.
func (e *Error) Error() string {
	if e == nil {
		return messages[CodeUnexpectedFailure]
	}
	_, message := stableError(e.Code)
	return message
}

// Unwrap retains the private cause for internal classification with errors.Is and errors.As.
func (e *Error) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.cause
}

// ExitCode returns the stable process exit code for this error.
func (e *Error) ExitCode() int {
	if e == nil {
		return 1
	}
	code, _ := stableError(e.Code)
	switch code {
	case CodeInvalidArgument, CodeInvalidConfiguration, CodeUnsafeTransport, CodeOutOfRange, CodeValidationFailed:
		return 2
	case CodeAuthenticationFailed, CodeCredentialInvalid, CodeUnauthenticated:
		return 3
	case CodePermissionDenied:
		return 4
	case CodeProfileNotFound, CodeNotFound:
		return 5
	case CodeAlreadyInitialized, CodeNotInitialized, CodeSetupInProgress, CodeAlreadyExists, CodeFailedPrecondition, CodeAborted:
		return 6
	case CodeAuthenticationUnavailable, CodeDeadlineExceeded, CodeRateLimited, CodeSessionRevocationUnconfirmed, CodeSetupUnavailable, CodeResourceExhausted, CodeUnavailable, CodeNetworkUnavailable:
		return 7
	default:
		return 1
	}
}

// MarshalJSON serializes only normalized public error data.
func (e *Error) MarshalJSON() ([]byte, error) {
	if e == nil {
		return json.Marshal(nil)
	}
	code, message := stableError(e.Code)
	public := struct {
		Code            string           `json:"code"`
		Message         string           `json:"message"`
		RequestID       string           `json:"request_id,omitempty"`
		FieldViolations []FieldViolation `json:"field_violations,omitempty"`
		RetryDelay      string           `json:"retry_delay,omitempty"`
	}{
		Code:      code,
		Message:   message,
		RequestID: normalizeRequestID(e.RequestID),
	}
	for _, violation := range e.FieldViolations {
		if normalized, ok := normalizeViolation(violation); ok {
			public.FieldViolations = append(public.FieldViolations, normalized)
		}
	}
	if e.RetryDelay > 0 {
		public.RetryDelay = e.RetryDelay.String()
	}
	return json.Marshal(public)
}

// Translate converts a local or Connect error into the stable CLI error contract.
func Translate(cause error) *Error {
	if typed, ok := errors.AsType[*Error](cause); ok {
		return typed
	}

	connectError, ok := errors.AsType[*connect.Error](cause)
	if !ok {
		return Unexpected(cause)
	}

	code := connectError.Code().String()
	var requestID string
	var violations []FieldViolation
	var retryDelay time.Duration
	for _, detail := range connectError.Details() {
		message, err := detail.Value()
		if err != nil {
			continue
		}
		switch value := message.(type) {
		case *errdetails.ErrorInfo:
			if value.GetDomain() == apiErrorDomain {
				if knownCode, ok := reasonCodes[value.GetReason()]; ok {
					code = knownCode
				}
			}
		case *errdetails.BadRequest:
			for _, violation := range value.GetFieldViolations() {
				if len(violations) == maxFieldViolations {
					break
				}
				if normalized, ok := normalizeViolation(FieldViolation{
					Field:       violation.GetField(),
					Reason:      violation.GetReason(),
					Description: violation.GetDescription(),
				}); ok {
					violations = append(violations, normalized)
				}
			}
		case *errdetails.RequestInfo:
			if requestID == "" {
				requestID = normalizeRequestID(value.GetRequestId())
			}
		case *errdetails.RetryInfo:
			if delay := value.GetRetryDelay(); delay != nil && delay.CheckValid() == nil && delay.AsDuration() > 0 {
				retryDelay = delay.AsDuration()
			}
		}
	}

	translated := New(code, cause)
	translated.RequestID = requestID
	if translated.RequestID == "" {
		translated.RequestID = normalizeRequestID(connectError.Meta().Get(requestIDHeader))
	}
	translated.FieldViolations = violations
	translated.RetryDelay = retryDelay
	return translated
}

func stableError(code string) (string, string) {
	message, ok := messages[code]
	if !ok {
		return CodeUnexpectedFailure, messages[CodeUnexpectedFailure]
	}
	return code, message
}

func normalizeViolation(value FieldViolation) (FieldViolation, bool) {
	field := normalizeField(value.Field)
	reason := strings.ToLower(strings.TrimSpace(value.Reason))
	description := normalizeDescription(value.Description)
	if field == "" || description == "" {
		return FieldViolation{}, false
	}
	if _, ok := fieldReasons[reason]; !ok {
		return FieldViolation{}, false
	}
	return FieldViolation{Field: field, Reason: reason, Description: description}, true
}

func normalizeField(value string) string {
	field := strings.TrimSpace(value)
	if len(field) == 0 || len(field) > maxPublicDescription {
		return ""
	}
	for offset := 0; offset < len(field); {
		if !isLowerLetter(field[offset]) {
			return ""
		}
		offset++
		for offset < len(field) && isFieldCharacter(field[offset]) {
			offset++
		}
		for offset < len(field) && field[offset] == '[' {
			offset++
			start := offset
			for offset < len(field) && field[offset] >= '0' && field[offset] <= '9' {
				offset++
			}
			if start == offset || offset == len(field) || field[offset] != ']' {
				return ""
			}
			offset++
		}
		if offset == len(field) {
			return field
		}
		if field[offset] != '.' {
			return ""
		}
		offset++
	}
	return ""
}

func normalizeDescription(value string) string {
	description := strings.Join(strings.Fields(value), " ")
	if len(description) == 0 || len(description) > maxPublicDescription {
		return ""
	}
	for index := range len(description) {
		character := description[index]
		if !((character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || strings.ContainsRune(" .,:;()/-", rune(character))) {
			return ""
		}
	}
	if _, ok := fieldDescriptions[description]; !ok {
		return ""
	}
	return description
}

func normalizeRequestID(value string) string {
	requestID := strings.TrimSpace(value)
	if len(requestID) == 0 || len(requestID) > maxRequestIDLength {
		return ""
	}
	for index := range len(requestID) {
		character := requestID[index]
		if !((character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character == '.' || character == '_' || character == '-') {
			return ""
		}
	}
	return requestID
}

func isLowerLetter(character byte) bool {
	return character >= 'a' && character <= 'z'
}

func isFieldCharacter(character byte) bool {
	return isLowerLetter(character) || (character >= '0' && character <= '9') || character == '_'
}
