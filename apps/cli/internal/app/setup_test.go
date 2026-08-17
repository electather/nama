package app

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/electather/nama/apps/cli/internal/auth"
	"github.com/electather/nama/apps/cli/internal/clierror"
	apiv1 "github.com/electather/nama/gen/go/nama/api/v1"
	"google.golang.org/protobuf/types/known/timestamppb"
)

const (
	setupProfile   = "work"
	setupServer    = "https://nama.example.test"
	bootstrapToken = "bootstrap-secret"
	setupPassword  = "correct-horse-battery-staple"
	setupBearer    = "bearer-secret"
)

var setupAdministrator = &apiv1.Administrator{
	Id:          "administrator-1",
	DisplayName: "Nama Admin",
	Email:       "admin@example.test",
}

func TestSetupOperation(t *testing.T) {
	expiresAt := time.Date(2026, time.August, 17, 12, 0, 0, 0, time.UTC)
	createUnavailable := connect.NewError(connect.CodeUnavailable, errors.New("connection lost after create"))
	storeErr := errors.New("keyring unavailable")

	for _, test := range []struct {
		name              string
		status            []setupStatusResult
		create            setupCreateResult
		signIn            setupSignInResult
		storeErr          error
		signOut           setupSignOutResult
		wantCode          string
		wantCreateCalls   int
		wantStatusCalls   int
		wantSignInCalls   int
		wantSignOutCalls  int
		wantStored        bool
		wantRecoveryDelay bool
	}{
		{
			name:            "creates an administrator, signs in, and stores its credential",
			status:          []setupStatusResult{{response: &apiv1.GetStatusResponse{}}},
			create:          setupCreateResult{response: &apiv1.CreateAdministratorResponse{Administrator: setupAdministrator}},
			signIn:          successfulSetupSignIn(expiresAt),
			wantStatusCalls: 1,
			wantCreateCalls: 1,
			wantSignInCalls: 1,
			wantStored:      true,
		},
		{
			name:            "does not reinterpret an initialized server as login",
			status:          []setupStatusResult{{response: &apiv1.GetStatusResponse{Initialized: true}}},
			wantCode:        "already_initialized",
			wantStatusCalls: 1,
		},
		{
			name:            "returns a wire application create failure without recovery",
			status:          []setupStatusResult{{response: &apiv1.GetStatusResponse{}}},
			create:          setupCreateResult{err: connect.NewWireError(connect.CodeUnavailable, errors.New("server rejected administrator creation"))},
			wantCode:        "unavailable",
			wantCreateCalls: 1,
			wantStatusCalls: 1,
		},
		{
			name: "continues after ambiguous creation only when recovery reports initialized",
			status: []setupStatusResult{
				{response: &apiv1.GetStatusResponse{}},
				{response: &apiv1.GetStatusResponse{Initialized: true}},
			},
			create:            setupCreateResult{err: createUnavailable},
			signIn:            successfulSetupSignIn(expiresAt),
			wantStatusCalls:   2,
			wantCreateCalls:   1,
			wantSignInCalls:   1,
			wantStored:        true,
			wantRecoveryDelay: true,
		},
		{
			name: "preserves an ambiguous creation failure when recovery reports uninitialized",
			status: []setupStatusResult{
				{response: &apiv1.GetStatusResponse{}},
				{response: &apiv1.GetStatusResponse{}},
			},
			create:          setupCreateResult{err: createUnavailable},
			wantCode:        "unavailable",
			wantStatusCalls: 2,
			wantCreateCalls: 1,
		},
		{
			name: "returns setup unavailable when recovery cannot establish initialization",
			status: []setupStatusResult{
				{response: &apiv1.GetStatusResponse{}},
				{err: connect.NewError(connect.CodeUnavailable, errors.New("setup unavailable"))},
			},
			create:          setupCreateResult{err: createUnavailable},
			wantCode:        "setup_unavailable",
			wantStatusCalls: 2,
			wantCreateCalls: 1,
		},
		{
			name:             "returns storage failure after confirmed revocation",
			status:           []setupStatusResult{{response: &apiv1.GetStatusResponse{}}},
			create:           setupCreateResult{response: &apiv1.CreateAdministratorResponse{Administrator: setupAdministrator}},
			signIn:           successfulSetupSignIn(expiresAt),
			storeErr:         storeErr,
			signOut:          setupSignOutResult{response: &apiv1.SignOutResponse{}},
			wantCode:         "credential_store_unavailable",
			wantStatusCalls:  1,
			wantCreateCalls:  1,
			wantSignInCalls:  1,
			wantSignOutCalls: 1,
		},
		{
			name:     "prioritizes ambiguous revocation over credential storage failure",
			status:   []setupStatusResult{{response: &apiv1.GetStatusResponse{}}},
			create:   setupCreateResult{response: &apiv1.CreateAdministratorResponse{Administrator: setupAdministrator}},
			signIn:   successfulSetupSignIn(expiresAt),
			storeErr: storeErr,
			signOut: setupSignOutResult{err: connect.NewError(
				connect.CodeUnavailable,
				errors.New("session revocation unconfirmed"),
			)},
			wantCode:         "session_revocation_unconfirmed",
			wantStatusCalls:  1,
			wantCreateCalls:  1,
			wantSignInCalls:  1,
			wantSignOutCalls: 1,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			setupClient := &setupServiceFake{status: test.status, create: test.create}
			authClient := &setupAuthServiceFake{signIn: test.signIn, signOut: test.signOut}
			credentials := &setupCredentialStoreFake{err: test.storeErr}

			result, err := Setup(t.Context(), testSetupInput(), setupClient, authClient, credentials)

			if test.wantCode != "" {
				requireAppErrorCode(t, err, test.wantCode)
				if strings.Contains(err.Error(), setupBearer) {
					t.Errorf("Setup() error leaked bearer: %v", err)
				}
			} else {
				if err != nil {
					t.Fatalf("Setup() error = %v", err)
				}
				if got, want := result.Profile, setupProfile; got != want {
					t.Errorf("result profile = %q, want %q", got, want)
				}
				if got, want := result.Server, setupServer; got != want {
					t.Errorf("result server = %q, want %q", got, want)
				}
				if !result.Initialized || !result.SignedIn {
					t.Errorf("result = %#v, want initialized and signed in", result)
				}
				if got := result.Administrator; got == nil || got.GetId() != setupAdministrator.GetId() || got.GetDisplayName() != setupAdministrator.GetDisplayName() || got.GetEmail() != setupAdministrator.GetEmail() {
					t.Errorf("result administrator = %#v, want %#v", got, setupAdministrator)
				}
				if got, want := result.CredentialExpiresAt, expiresAt; !got.Equal(want) {
					t.Errorf("result credential expiry = %s, want %s", got, want)
				}
				encoded, marshalErr := json.Marshal(result)
				if marshalErr != nil {
					t.Fatalf("json.Marshal(result) error = %v", marshalErr)
				}
				if strings.Contains(string(encoded), setupBearer) {
					t.Errorf("setup result leaked bearer: %s", encoded)
				}
			}

			if got, want := setupClient.createCalls, test.wantCreateCalls; got != want {
				t.Errorf("CreateAdministrator calls = %d, want %d", got, want)
			}
			if got, want := setupClient.statusCalls, test.wantStatusCalls; got != want {
				t.Errorf("GetStatus calls = %d, want %d", got, want)
			}
			if got, want := authClient.signInCalls, test.wantSignInCalls; got != want {
				t.Errorf("SignIn calls = %d, want %d", got, want)
			}
			if got, want := authClient.signOutCalls, test.wantSignOutCalls; got != want {
				t.Errorf("SignOut calls = %d, want %d", got, want)
			}
			if got, want := credentials.wrote, test.wantSignInCalls == 1; got != want {
				t.Errorf("credential store write = %t, want %t", got, want)
			}
			if test.wantStored {
				if got, want := credentials.profile, setupProfile; got != want {
					t.Errorf("stored profile = %q, want %q", got, want)
				}
				if got, want := credentials.credential, (auth.Credential{Token: setupBearer, ExpiresAt: expiresAt, Server: setupServer}); got != want {
					t.Errorf("stored credential = %#v, want %#v", got, want)
				}
			}
			if setupClient.createCalls == 1 {
				got := setupClient.createRequests[0].Msg
				if got.GetBootstrapToken() != bootstrapToken || got.GetDisplayName() != setupAdministrator.GetDisplayName() || got.GetEmail() != setupAdministrator.GetEmail() || got.GetPassword() != setupPassword {
					t.Errorf("CreateAdministrator request = %#v, want resolved setup input", got)
				}
			}
			if authClient.signInCalls == 1 {
				got := authClient.signInRequests[0].Msg
				if got.GetEmail() != setupAdministrator.GetEmail() || got.GetPassword() != setupPassword {
					t.Errorf("SignIn request = %#v, want setup email and password", got)
				}
			}
			if authClient.signOutCalls == 1 {
				if got := authClient.signOutRequests[0].Header().Get("Authorization"); got != "Bearer "+setupBearer {
					t.Errorf("SignOut authorization = %q, want new bearer", got)
				}
			}
			if test.wantRecoveryDelay {
				if _, ok := setupClient.statusContexts[1].Deadline(); !ok {
					t.Error("recovery GetStatus context has no deadline")
				}
			}
		})
	}
}

func TestSetupUsesFreshBoundedContextToSettleAmbiguousCreation(t *testing.T) {
	expiresAt := time.Date(2026, time.August, 17, 12, 0, 0, 0, time.UTC)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()

	setupClient := &setupServiceFake{
		status: []setupStatusResult{
			{response: &apiv1.GetStatusResponse{}},
			{response: &apiv1.GetStatusResponse{Initialized: true}},
		},
		create:   setupCreateResult{err: connect.NewError(connect.CodeUnavailable, errors.New("connection lost after create"))},
		onCreate: cancel,
	}
	authClient := &setupAuthServiceFake{
		signIn:                 successfulSetupSignIn(expiresAt),
		rejectCanceledContexts: true,
	}
	credentials := &setupCredentialStoreFake{rejectCanceledContexts: true}

	result, err := Setup(ctx, testSetupInput(), setupClient, authClient, credentials)

	if err != nil {
		t.Fatalf("Setup() error = %v, want successful settlement", err)
	}
	if ctx.Err() == nil {
		t.Fatal("test caller context was not canceled during administrator creation")
	}
	if !result.Initialized || !result.SignedIn || !credentials.wrote {
		t.Errorf("Setup() result = %#v, credential stored = %t; want completed setup", result, credentials.wrote)
	}
	if setupClient.createCalls != 1 {
		t.Errorf("CreateAdministrator calls = %d, want 1 without replay", setupClient.createCalls)
	}
	if setupClient.statusCalls != 2 {
		t.Errorf("GetStatus calls = %d, want initial check and one recovery check", setupClient.statusCalls)
	}
	if len(authClient.signInContextErrors) != 1 || authClient.signInContextErrors[0] != nil {
		t.Errorf("SignIn context errors = %v, want one active settlement context", authClient.signInContextErrors)
	}
	if len(authClient.signInContextDeadlines) != 1 || !authClient.signInContextDeadlines[0] {
		t.Errorf("SignIn context deadlines = %v, want one bounded settlement context", authClient.signInContextDeadlines)
	}
	if len(credentials.putContextErrors) != 1 || credentials.putContextErrors[0] != nil {
		t.Errorf("credential Put context errors = %v, want one active settlement context", credentials.putContextErrors)
	}
	if len(credentials.putContextDeadlines) != 1 || !credentials.putContextDeadlines[0] {
		t.Errorf("credential Put context deadlines = %v, want one bounded settlement context", credentials.putContextDeadlines)
	}
}

func TestSetupRecoversAllAmbiguousNonWireOutcomes(t *testing.T) {
	for _, code := range []connect.Code{
		connect.CodeUnavailable,
		connect.CodeDeadlineExceeded,
		connect.CodeCanceled,
		connect.CodeUnknown,
		connect.CodeInvalidArgument,
	} {
		t.Run(code.String(), func(t *testing.T) {
			setupClient := &setupServiceFake{
				status: []setupStatusResult{
					{response: &apiv1.GetStatusResponse{}},
					{response: &apiv1.GetStatusResponse{Initialized: true}},
				},
				create: setupCreateResult{err: connect.NewError(code, errors.New("response lost locally"))},
			}
			authClient := &setupAuthServiceFake{signIn: successfulSetupSignIn(time.Date(2026, time.August, 17, 12, 0, 0, 0, time.UTC))}
			credentials := &setupCredentialStoreFake{}

			_, err := Setup(t.Context(), testSetupInput(), setupClient, authClient, credentials)
			if err != nil {
				t.Fatalf("Setup() error = %v", err)
			}
			if got, want := setupClient.statusCalls, 2; got != want {
				t.Errorf("GetStatus calls = %d, want %d", got, want)
			}
			if got, want := setupClient.createCalls, 1; got != want {
				t.Errorf("CreateAdministrator calls = %d, want %d", got, want)
			}
			if got, want := authClient.signInCalls, 1; got != want {
				t.Errorf("SignIn calls = %d, want %d", got, want)
			}
			if got, want := credentials.putCalls, 1; got != want {
				t.Errorf("credential writes = %d, want %d", got, want)
			}
			if _, ok := setupClient.statusContexts[1].Deadline(); !ok {
				t.Error("recovery GetStatus context has no deadline")
			}
		})
	}
}

func TestSetupPreservesDeadlineAfterNegativeRecovery(t *testing.T) {
	setupClient := &setupServiceFake{
		status: []setupStatusResult{
			{response: &apiv1.GetStatusResponse{}},
			{response: &apiv1.GetStatusResponse{}},
		},
		create: setupCreateResult{err: connect.NewError(connect.CodeDeadlineExceeded, errors.New("response lost locally"))},
	}
	authClient := &setupAuthServiceFake{}
	credentials := &setupCredentialStoreFake{}

	_, err := Setup(t.Context(), testSetupInput(), setupClient, authClient, credentials)

	requireAppErrorCode(t, err, "deadline_exceeded")
	if got := setupClient.statusCalls; got != 2 {
		t.Errorf("GetStatus calls = %d, want 2", got)
	}
	if got := setupClient.createCalls; got != 1 {
		t.Errorf("CreateAdministrator calls = %d, want 1", got)
	}
	if got := authClient.signInCalls; got != 0 {
		t.Errorf("SignIn calls = %d, want 0 after negative recovery", got)
	}
	if got := credentials.putCalls; got != 0 {
		t.Errorf("credential writes = %d, want 0 after negative recovery", got)
	}
}

func TestSetupStopsAfterInitialStatusOrSignInFailure(t *testing.T) {
	for _, test := range []struct {
		name            string
		status          []setupStatusResult
		create          setupCreateResult
		signIn          setupSignInResult
		wantCode        string
		wantStatusCalls int
		wantCreateCalls int
		wantSignInCalls int
	}{
		{
			name:            "initial status",
			status:          []setupStatusResult{{err: connect.NewWireError(connect.CodeUnavailable, errors.New("server unavailable"))}},
			wantCode:        "unavailable",
			wantStatusCalls: 1,
		},
		{
			name:            "sign-in",
			status:          []setupStatusResult{{response: &apiv1.GetStatusResponse{}}},
			create:          setupCreateResult{response: &apiv1.CreateAdministratorResponse{Administrator: setupAdministrator}},
			signIn:          setupSignInResult{err: connect.NewWireError(connect.CodeUnauthenticated, errors.New("sign-in rejected"))},
			wantCode:        "unauthenticated",
			wantStatusCalls: 1,
			wantCreateCalls: 1,
			wantSignInCalls: 1,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			setupClient := &setupServiceFake{status: test.status, create: test.create}
			authClient := &setupAuthServiceFake{signIn: test.signIn}
			credentials := &setupCredentialStoreFake{}

			_, err := Setup(t.Context(), testSetupInput(), setupClient, authClient, credentials)

			requireAppErrorCode(t, err, test.wantCode)
			if got := setupClient.statusCalls; got != test.wantStatusCalls {
				t.Errorf("GetStatus calls = %d, want %d", got, test.wantStatusCalls)
			}
			if got := setupClient.createCalls; got != test.wantCreateCalls {
				t.Errorf("CreateAdministrator calls = %d, want %d", got, test.wantCreateCalls)
			}
			if got := authClient.signInCalls; got != test.wantSignInCalls {
				t.Errorf("SignIn calls = %d, want %d", got, test.wantSignInCalls)
			}
			if got := credentials.putCalls; got != 0 {
				t.Errorf("credential writes = %d, want 0 after failed setup stage", got)
			}
		})
	}
}

func TestSetupRejectsMalformedResponsesBeforeLaterStages(t *testing.T) {
	expiresAt := time.Date(2026, time.August, 17, 12, 0, 0, 0, time.UTC)

	for _, test := range []struct {
		name            string
		status          []setupStatusResult
		create          setupCreateResult
		signIn          setupSignInResult
		wantStatusCalls int
		wantCreateCalls int
		wantSignInCalls int
	}{
		{
			name:            "missing initial status",
			status:          []setupStatusResult{{}},
			wantStatusCalls: 1,
		},
		{
			name:            "administrator missing from creation",
			status:          []setupStatusResult{{response: &apiv1.GetStatusResponse{}}},
			create:          setupCreateResult{response: &apiv1.CreateAdministratorResponse{}},
			wantStatusCalls: 1,
			wantCreateCalls: 1,
		},
		{
			name:   "administrator email missing from sign-in",
			status: []setupStatusResult{{response: &apiv1.GetStatusResponse{}}},
			create: setupCreateResult{response: &apiv1.CreateAdministratorResponse{
				Administrator: setupAdministrator,
			}},
			signIn: setupSignInResult{response: &apiv1.SignInResponse{
				Administrator: &apiv1.Administrator{Id: "administrator-1", DisplayName: "Nama Admin"},
				Credential:    &apiv1.BearerCredential{Token: setupBearer, ExpiresAt: timestamppb.New(expiresAt)},
			}},
			wantStatusCalls: 1,
			wantCreateCalls: 1,
			wantSignInCalls: 1,
		},
		{
			name:   "credential missing from sign-in",
			status: []setupStatusResult{{response: &apiv1.GetStatusResponse{}}},
			create: setupCreateResult{response: &apiv1.CreateAdministratorResponse{
				Administrator: setupAdministrator,
			}},
			signIn:          setupSignInResult{response: &apiv1.SignInResponse{Administrator: setupAdministrator}},
			wantStatusCalls: 1,
			wantCreateCalls: 1,
			wantSignInCalls: 1,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			setupClient := &setupServiceFake{status: test.status, create: test.create}
			authClient := &setupAuthServiceFake{signIn: test.signIn}
			credentials := &setupCredentialStoreFake{}

			_, err := Setup(t.Context(), testSetupInput(), setupClient, authClient, credentials)

			requireAppErrorCode(t, err, "unexpected_failure")
			if got := setupClient.statusCalls; got != test.wantStatusCalls {
				t.Errorf("GetStatus calls = %d, want %d", got, test.wantStatusCalls)
			}
			if got := setupClient.createCalls; got != test.wantCreateCalls {
				t.Errorf("CreateAdministrator calls = %d, want %d", got, test.wantCreateCalls)
			}
			if got := authClient.signInCalls; got != test.wantSignInCalls {
				t.Errorf("SignIn calls = %d, want %d", got, test.wantSignInCalls)
			}
			if got := credentials.putCalls; got != 0 {
				t.Errorf("credential writes = %d, want 0 after malformed response", got)
			}
		})
	}
}

func TestSetupRevokesBearerFromMalformedSignInResponse(t *testing.T) {
	expiresAt := time.Date(2026, time.August, 17, 12, 0, 0, 0, time.UTC)

	for _, test := range []struct {
		name     string
		signIn   setupSignInResult
		signOut  setupSignOutResult
		wantCode string
	}{
		{
			name: "missing administrator",
			signIn: setupSignInResult{response: &apiv1.SignInResponse{
				Credential: &apiv1.BearerCredential{Token: setupBearer, ExpiresAt: timestamppb.New(expiresAt)},
			}},
			wantCode: "unexpected_failure",
		},
		{
			name: "missing credential expiry",
			signIn: setupSignInResult{response: &apiv1.SignInResponse{
				Administrator: setupAdministrator,
				Credential:    &apiv1.BearerCredential{Token: setupBearer},
			}},
			wantCode: "unexpected_failure",
		},
		{
			name: "unconfirmed revocation",
			signIn: setupSignInResult{response: &apiv1.SignInResponse{
				Credential: &apiv1.BearerCredential{Token: setupBearer, ExpiresAt: timestamppb.New(expiresAt)},
			}},
			signOut:  setupSignOutResult{err: connect.NewError(connect.CodeUnavailable, errors.New("revocation unavailable"))},
			wantCode: "session_revocation_unconfirmed",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			setupClient := &setupServiceFake{
				status: []setupStatusResult{{response: &apiv1.GetStatusResponse{}}},
				create: setupCreateResult{response: &apiv1.CreateAdministratorResponse{Administrator: setupAdministrator}},
			}
			authClient := &setupAuthServiceFake{signIn: test.signIn, signOut: test.signOut}
			credentials := &setupCredentialStoreFake{}

			_, err := Setup(t.Context(), testSetupInput(), setupClient, authClient, credentials)

			requireAppErrorCode(t, err, test.wantCode)
			if strings.Contains(err.Error(), setupBearer) {
				t.Errorf("Setup() error leaked bearer: %v", err)
			}
			if got := credentials.putCalls; got != 0 {
				t.Errorf("credential writes = %d, want 0 after malformed sign-in response", got)
			}
			if got := authClient.signOutCalls; got != 1 {
				t.Errorf("SignOut calls = %d, want 1 for a malformed response with a usable bearer", got)
			}
			if len(authClient.signOutRequests) != 1 {
				t.Fatal("SignOut did not receive exactly one request")
			}
			if got := authClient.signOutRequests[0].Header().Get("Authorization"); got != "Bearer "+setupBearer {
				t.Errorf("SignOut authorization = %q, want new bearer", got)
			}
		})
	}
}

func TestSetupRestoresPriorCredentialBeforeRevocationAfterMutatingStoreFailure(t *testing.T) {
	expiresAt := time.Date(2026, time.August, 17, 12, 0, 0, 0, time.UTC)
	storeErr := errors.New("keyring write failed")
	restoreErr := errors.New("keyring restore failed")
	previous := auth.Credential{Token: "prior-bearer", ExpiresAt: expiresAt.Add(-time.Hour), Server: setupServer}
	newCredential := auth.Credential{Token: setupBearer, ExpiresAt: expiresAt, Server: setupServer}

	for _, test := range []struct {
		name        string
		previous    auth.Credential
		exists      bool
		putErrors   []error
		putChanges  []bool
		signOut     setupSignOutResult
		wantCode    string
		wantEvents  string
		wantStored  auth.Credential
		wantExists  bool
		wantPuts    int
		wantDeletes int
	}{
		{
			name:       "restores prior credential before revocation",
			previous:   previous,
			exists:     true,
			putErrors:  []error{storeErr, nil},
			putChanges: []bool{true, true},
			wantCode:   "credential_store_unavailable",
			wantEvents: "put,put,sign-out",
			wantStored: previous,
			wantExists: true,
			wantPuts:   2,
		},
		{
			name:        "deletes newly stored credential before revocation when no prior record exists",
			putErrors:   []error{storeErr},
			putChanges:  []bool{true},
			wantCode:    "credential_store_unavailable",
			wantEvents:  "put,delete,sign-out",
			wantExists:  false,
			wantPuts:    1,
			wantDeletes: 1,
		},
		{
			name:       "returns storage failure when restoration fails but revocation is confirmed",
			previous:   previous,
			exists:     true,
			putErrors:  []error{storeErr, restoreErr},
			putChanges: []bool{true, false},
			wantCode:   "credential_store_unavailable",
			wantEvents: "put,put,sign-out",
			wantStored: newCredential,
			wantExists: true,
			wantPuts:   2,
		},
		{
			name:       "prioritizes unconfirmed revocation over restoration failure",
			previous:   previous,
			exists:     true,
			putErrors:  []error{storeErr, restoreErr},
			putChanges: []bool{true, false},
			signOut:    setupSignOutResult{err: connect.NewError(connect.CodeUnavailable, errors.New("revocation unavailable"))},
			wantCode:   "session_revocation_unconfirmed",
			wantEvents: "put,put,sign-out",
			wantStored: newCredential,
			wantExists: true,
			wantPuts:   2,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			events := []string{}
			setupClient := &setupServiceFake{
				status: []setupStatusResult{{response: &apiv1.GetStatusResponse{}}},
				create: setupCreateResult{response: &apiv1.CreateAdministratorResponse{Administrator: setupAdministrator}},
			}
			authClient := &setupAuthServiceFake{
				signIn:  successfulSetupSignIn(expiresAt),
				signOut: test.signOut,
				events:  &events,
			}
			credentials := &setupCredentialStoreFake{
				credential: test.previous,
				exists:     test.exists,
				putErrors:  test.putErrors,
				putChanges: test.putChanges,
				events:     &events,
			}

			_, err := Setup(t.Context(), testSetupInput(), setupClient, authClient, credentials)

			requireAppErrorCode(t, err, test.wantCode)
			if strings.Contains(err.Error(), setupBearer) {
				t.Errorf("Setup() error leaked bearer: %v", err)
			}
			if got := strings.Join(events, ","); got != test.wantEvents {
				t.Errorf("persistence and revocation order = %q, want %q", got, test.wantEvents)
			}
			if got := credentials.putCalls; got != test.wantPuts {
				t.Errorf("credential writes = %d, want %d", got, test.wantPuts)
			}
			if got := credentials.deleteCalls; got != test.wantDeletes {
				t.Errorf("credential deletes = %d, want %d", got, test.wantDeletes)
			}
			if got := credentials.credential; got != test.wantStored {
				t.Errorf("stored credential = %#v, want %#v", got, test.wantStored)
			}
			if got := credentials.exists; got != test.wantExists {
				t.Errorf("credential exists = %t, want %t", got, test.wantExists)
			}
			if got := authClient.signOutCalls; got != 1 {
				t.Errorf("SignOut calls = %d, want 1", got)
			}
			if len(authClient.signOutRequests) != 1 {
				t.Fatal("SignOut did not receive exactly one request")
			}
			if got := authClient.signOutRequests[0].Header().Get("Authorization"); got != "Bearer "+setupBearer {
				t.Errorf("SignOut authorization = %q, want new bearer", got)
			}
		})
	}
}

func testSetupInput() SetupInput {
	return SetupInput{
		Profile:        setupProfile,
		Server:         setupServer,
		BootstrapToken: bootstrapToken,
		DisplayName:    setupAdministrator.GetDisplayName(),
		Email:          setupAdministrator.GetEmail(),
		Password:       setupPassword,
	}
}

func successfulSetupSignIn(expiresAt time.Time) setupSignInResult {
	return setupSignInResult{response: &apiv1.SignInResponse{
		Administrator: setupAdministrator,
		Credential: &apiv1.BearerCredential{
			Token:     setupBearer,
			ExpiresAt: timestamppb.New(expiresAt),
		},
	}}
}

func requireAppErrorCode(t *testing.T, err error, want string) {
	t.Helper()
	if err == nil {
		t.Fatalf("Setup() error = nil, want code %q", want)
	}
	cliErr, ok := errors.AsType[*clierror.Error](err)
	if !ok {
		t.Fatalf("Setup() error = %T %v, want *clierror.Error with code %q", err, err, want)
	}
	if got := cliErr.Code; got != want {
		t.Errorf("Setup() error code = %q, want %q", got, want)
	}
}

type setupStatusResult struct {
	response *apiv1.GetStatusResponse
	err      error
}

type setupCreateResult struct {
	response *apiv1.CreateAdministratorResponse
	err      error
}

type setupSignInResult struct {
	response *apiv1.SignInResponse
	err      error
}

type setupSignOutResult struct {
	response *apiv1.SignOutResponse
	err      error
}

type setupServiceFake struct {
	status         []setupStatusResult
	create         setupCreateResult
	statusCalls    int
	createCalls    int
	statusContexts []context.Context
	createRequests []*connect.Request[apiv1.CreateAdministratorRequest]
	onCreate       func()
}

func (f *setupServiceFake) GetStatus(ctx context.Context, _ *connect.Request[apiv1.GetStatusRequest]) (*connect.Response[apiv1.GetStatusResponse], error) {
	f.statusCalls++
	f.statusContexts = append(f.statusContexts, ctx)
	if f.statusCalls > len(f.status) {
		return nil, errors.New("unexpected GetStatus call")
	}
	result := f.status[f.statusCalls-1]
	if result.err != nil {
		return nil, result.err
	}
	return connect.NewResponse(result.response), nil
}

func (f *setupServiceFake) CreateAdministrator(_ context.Context, request *connect.Request[apiv1.CreateAdministratorRequest]) (*connect.Response[apiv1.CreateAdministratorResponse], error) {
	f.createCalls++
	f.createRequests = append(f.createRequests, request)
	if f.onCreate != nil {
		f.onCreate()
	}
	if f.create.err != nil {
		return nil, f.create.err
	}
	return connect.NewResponse(f.create.response), nil
}

type setupAuthServiceFake struct {
	signIn                 setupSignInResult
	signOut                setupSignOutResult
	signInCalls            int
	signOutCalls           int
	signInRequests         []*connect.Request[apiv1.SignInRequest]
	signOutRequests        []*connect.Request[apiv1.SignOutRequest]
	events                 *[]string
	rejectCanceledContexts bool
	signInContextErrors    []error
	signInContextDeadlines []bool
}

func (f *setupAuthServiceFake) SignIn(ctx context.Context, request *connect.Request[apiv1.SignInRequest]) (*connect.Response[apiv1.SignInResponse], error) {
	f.signInCalls++
	f.signInRequests = append(f.signInRequests, request)
	_, hasDeadline := ctx.Deadline()
	f.signInContextErrors = append(f.signInContextErrors, ctx.Err())
	f.signInContextDeadlines = append(f.signInContextDeadlines, hasDeadline)
	if f.rejectCanceledContexts && ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if f.signIn.err != nil {
		return nil, f.signIn.err
	}
	return connect.NewResponse(f.signIn.response), nil
}

func (f *setupAuthServiceFake) GetCurrentUser(context.Context, *connect.Request[apiv1.GetCurrentUserRequest]) (*connect.Response[apiv1.GetCurrentUserResponse], error) {
	return nil, errors.New("unexpected GetCurrentUser call")
}

func (f *setupAuthServiceFake) SignOut(_ context.Context, request *connect.Request[apiv1.SignOutRequest]) (*connect.Response[apiv1.SignOutResponse], error) {
	f.signOutCalls++
	f.signOutRequests = append(f.signOutRequests, request)
	if f.events != nil {
		*f.events = append(*f.events, "sign-out")
	}
	if f.signOut.err != nil {
		return nil, f.signOut.err
	}
	return connect.NewResponse(f.signOut.response), nil
}

type setupCredentialStoreFake struct {
	credential             auth.Credential
	profile                string
	err                    error
	putErrors              []error
	putChanges             []bool
	deleteErr              error
	exists                 bool
	wrote                  bool
	getCalls               int
	putCalls               int
	deleteCalls            int
	events                 *[]string
	rejectCanceledContexts bool
	putContextErrors       []error
	putContextDeadlines    []bool
}

func (f *setupCredentialStoreFake) Put(ctx context.Context, profile string, credential auth.Credential) error {
	_, hasDeadline := ctx.Deadline()
	f.putContextErrors = append(f.putContextErrors, ctx.Err())
	f.putContextDeadlines = append(f.putContextDeadlines, hasDeadline)
	if f.rejectCanceledContexts && ctx.Err() != nil {
		return ctx.Err()
	}
	index := f.putCalls
	f.putCalls++
	f.wrote = true
	if f.events != nil {
		*f.events = append(*f.events, "put")
	}
	if index >= len(f.putChanges) || f.putChanges[index] {
		f.profile = profile
		f.credential = credential
		f.exists = true
	}
	if index < len(f.putErrors) {
		return f.putErrors[index]
	}
	return f.err
}

func (f *setupCredentialStoreFake) Get(context.Context, string) (auth.Credential, bool, error) {
	f.getCalls++
	return f.credential, f.exists, nil
}

func (f *setupCredentialStoreFake) Delete(context.Context, string) error {
	f.deleteCalls++
	if f.events != nil {
		*f.events = append(*f.events, "delete")
	}
	if f.deleteErr != nil {
		return f.deleteErr
	}
	f.credential = auth.Credential{}
	f.exists = false
	return nil
}
