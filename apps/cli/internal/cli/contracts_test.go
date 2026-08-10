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
