package clierror

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/genproto/googleapis/rpc/errdetails"
	"google.golang.org/protobuf/types/known/durationpb"
)

func TestTranslatePrefersKnownErrorInfoReason(t *testing.T) {
	detail, err := connect.NewErrorDetail(&errdetails.ErrorInfo{
		Reason: "ALREADY_INITIALIZED",
		Domain: "nama.api.v1",
	})
	if err != nil {
		t.Fatalf("NewErrorDetail() error = %v", err)
	}

	raw := connect.NewError(connect.CodeFailedPrecondition, errors.New("server details"))
	raw.AddDetail(detail)
	translated := Translate(raw)
	if translated.Code != "already_initialized" {
		t.Errorf("Code = %q, want already_initialized", translated.Code)
	}
	if got := translated.ExitCode(); got != 6 {
		t.Errorf("ExitCode() = %d, want 6", got)
	}
}

func TestTranslateFallsBackToConnectCodeForUnknownReason(t *testing.T) {
	detail, err := connect.NewErrorDetail(&errdetails.ErrorInfo{
		Reason: "NEWER_SERVER_REASON",
		Domain: "nama.api.v1",
	})
	if err != nil {
		t.Fatalf("NewErrorDetail() error = %v", err)
	}

	raw := connect.NewError(connect.CodeFailedPrecondition, errors.New("server details"))
	raw.AddDetail(detail)
	translated := Translate(raw)
	if translated.Code != "failed_precondition" {
		t.Errorf("Code = %q, want failed_precondition", translated.Code)
	}
	if got := translated.ExitCode(); got != 6 {
		t.Errorf("ExitCode() = %d, want 6", got)
	}
}

func TestTranslateNormalizesPublicDetails(t *testing.T) {
	errorInfo, err := connect.NewErrorDetail(&errdetails.ErrorInfo{
		Reason: "RATE_LIMITED",
		Domain: "nama.api.v1",
	})
	if err != nil {
		t.Fatalf("NewErrorDetail(ErrorInfo) error = %v", err)
	}
	badRequest, err := connect.NewErrorDetail(&errdetails.BadRequest{FieldViolations: []*errdetails.BadRequest_FieldViolation{{
		Field:       " email ",
		Description: " Use a valid email address. ",
		Reason:      "INVALID_FORMAT",
	}}})
	if err != nil {
		t.Fatalf("NewErrorDetail(BadRequest) error = %v", err)
	}
	requestInfo, err := connect.NewErrorDetail(&errdetails.RequestInfo{RequestId: "request-123"})
	if err != nil {
		t.Fatalf("NewErrorDetail(RequestInfo) error = %v", err)
	}
	retryInfo, err := connect.NewErrorDetail(&errdetails.RetryInfo{RetryDelay: durationpb.New(1500 * time.Millisecond)})
	if err != nil {
		t.Fatalf("NewErrorDetail(RetryInfo) error = %v", err)
	}

	raw := connect.NewError(connect.CodeResourceExhausted, errors.New("server details"))
	raw.AddDetail(errorInfo)
	raw.AddDetail(badRequest)
	raw.AddDetail(requestInfo)
	raw.AddDetail(retryInfo)
	translated := Translate(raw)
	if translated.RequestID != "request-123" {
		t.Errorf("RequestID = %q, want request-123", translated.RequestID)
	}
	if translated.RetryDelay != 1500*time.Millisecond {
		t.Errorf("RetryDelay = %s, want 1.5s", translated.RetryDelay)
	}
	if len(translated.FieldViolations) != 1 {
		t.Fatalf("FieldViolations length = %d, want 1", len(translated.FieldViolations))
	}
	violation := translated.FieldViolations[0]
	if violation.Field != "email" {
		t.Errorf("violation field = %q, want email", violation.Field)
	}
	if violation.Reason != "invalid_format" {
		t.Errorf("violation reason = %q, want invalid_format", violation.Reason)
	}
	if violation.Description != "Use a valid email address." {
		t.Errorf("violation description = %q, want normalized safe description", violation.Description)
	}
}

func TestErrorJSONEncodesRetryDelayAsUnitBearingString(t *testing.T) {
	for _, test := range []struct {
		name       string
		retryDelay time.Duration
		want       string
	}{
		{
			name:       "positive delay",
			retryDelay: 1500 * time.Millisecond,
			want:       `{"code":"rate_limited","message":"Too many requests. Try again later.","retry_delay":"1.5s"}`,
		},
		{
			name: "absent delay",
			want: `{"code":"rate_limited","message":"Too many requests. Try again later."}`,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			encoded, err := json.Marshal(&Error{Code: CodeRateLimited, RetryDelay: test.retryDelay})
			if err != nil {
				t.Fatalf("json.Marshal() error = %v", err)
			}
			if got := string(encoded); got != test.want {
				t.Errorf("error JSON = %s, want %s", got, test.want)
			}
		})
	}
}

func TestTranslateUsesStableExitCodes(t *testing.T) {
	for _, test := range []struct {
		name string
		code connect.Code
		want int
	}{
		{"unexpected", connect.CodeInternal, 1},
		{"invalid argument", connect.CodeInvalidArgument, 2},
		{"authentication", connect.CodeUnauthenticated, 3},
		{"permission", connect.CodePermissionDenied, 4},
		{"not found", connect.CodeNotFound, 5},
		{"conflict", connect.CodeFailedPrecondition, 6},
		{"unavailable", connect.CodeUnavailable, 7},
	} {
		t.Run(test.name, func(t *testing.T) {
			translated := Translate(connect.NewError(test.code, errors.New("server details")))
			if got := translated.ExitCode(); got != test.want {
				t.Errorf("ExitCode() = %d, want %d", got, test.want)
			}
		})
	}
}

func TestTranslateRedactsPrivateCause(t *testing.T) {
	private := errors.New("password=correct-horse bearer=stored-session-bearer")
	raw := connect.NewError(connect.CodeInternal, private)
	translated := Translate(raw)

	if !errors.Is(translated, private) {
		t.Error("translated error does not retain its private cause")
	}
	encoded, err := json.Marshal(translated)
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	public := translated.Error() + " " + string(encoded)
	for _, secret := range []string{"correct-horse", "stored-session-bearer"} {
		if strings.Contains(public, secret) {
			t.Errorf("public error contains %q: %q", secret, public)
		}
	}
}
