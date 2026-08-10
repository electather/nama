package cli

import (
	"testing"
	"time"

	apiv1 "github.com/electather/nama/gen/go/nama/api/v1"
	"google.golang.org/genproto/googleapis/rpc/errdetails"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/durationpb"
	"google.golang.org/protobuf/types/known/timestamppb"
)

func TestContractRoundTrips(t *testing.T) {
	fixtures := []proto.Message{
		&apiv1.HttpHeader{Name: "x-test", Value: "public"},
		&apiv1.BearerCredential{Token: "opaque", ExpiresAt: timestamppb.New(time.Unix(1, 0))},
		&errdetails.ErrorInfo{Reason: "TEST", Domain: "nama.api.v1"},
		&errdetails.BadRequest{FieldViolations: []*errdetails.BadRequest_FieldViolation{{
			Field: "field", Description: "invalid", Reason: "REQUIRED",
		}}},
		&errdetails.RequestInfo{RequestId: "request-1"},
		&errdetails.RetryInfo{RetryDelay: durationpb.New(time.Second)},
	}

	for _, want := range fixtures {
		encoded, err := proto.Marshal(want)
		if err != nil {
			t.Fatal(err)
		}
		got := want.ProtoReflect().Type().New().Interface()
		if err := proto.Unmarshal(encoded, got); err != nil {
			t.Fatal(err)
		}
		if !proto.Equal(got, want) {
			t.Fatalf("round trip mismatch for %s", want.ProtoReflect().Descriptor().FullName())
		}
	}
}

func TestOperatorHealthContractRoundTrips(t *testing.T) {
	check := &apiv1.CheckResponse{
		Status:         apiv1.ServingStatus_SERVING_STATUS_SERVING,
		ServerVersion:  "0.1.0",
		Initialized:    true,
		Ready:          true,
		DatabaseStatus: apiv1.ServingStatus_SERVING_STATUS_SERVING,
	}
	encodedCheck, err := proto.Marshal(check)
	if err != nil {
		t.Fatal(err)
	}
	decodedCheck := &apiv1.CheckResponse{}
	if err := proto.Unmarshal(encodedCheck, decodedCheck); err != nil {
		t.Fatal(err)
	}
	if !proto.Equal(decodedCheck, check) {
		t.Fatal("health check round trip mismatch")
	}

	diagnostics := &apiv1.GetDiagnosticsResponse{
		ServerVersion: "0.1.0",
		RequestId:     "request-1",
		Components: []*apiv1.DiagnosticComponent{
			{Name: "core", Status: apiv1.ServingStatus_SERVING_STATUS_SERVING, Summary: "ready", CheckedAt: timestamppb.New(time.Unix(1, 0))},
			{Name: "database", Status: apiv1.ServingStatus_SERVING_STATUS_SERVING, Summary: "connected", CheckedAt: timestamppb.New(time.Unix(2, 0))},
			{Name: "provider_instance/opaque-id", Status: apiv1.ServingStatus_SERVING_STATUS_NOT_SERVING, Summary: "unavailable", CheckedAt: timestamppb.New(time.Unix(3, 0))},
		},
	}
	encodedDiagnostics, err := proto.Marshal(diagnostics)
	if err != nil {
		t.Fatal(err)
	}
	decodedDiagnostics := &apiv1.GetDiagnosticsResponse{}
	if err := proto.Unmarshal(encodedDiagnostics, decodedDiagnostics); err != nil {
		t.Fatal(err)
	}
	if !proto.Equal(decodedDiagnostics, diagnostics) {
		t.Fatal("diagnostics round trip mismatch")
	}
	wantNames := []string{"core", "database", "provider_instance/opaque-id"}
	for index, want := range wantNames {
		if got := decodedDiagnostics.Components[index].Name; got != want {
			t.Fatalf("component %d name = %q, want %q", index, got, want)
		}
	}

	methods := apiv1.File_nama_api_v1_health_proto.Services().ByName("HealthService").Methods()
	if methods.ByName("Check") == nil || methods.ByName("GetDiagnostics") == nil {
		t.Fatal("health service method descriptors are incomplete")
	}
}
