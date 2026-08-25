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
	apiv1 "github.com/electather/nama/gen/go/nama/api/v1"
	"google.golang.org/protobuf/types/known/timestamppb"
)

const (
	loginProfile  = "work"
	loginServer   = "https://nama.example.test"
	loginEmail    = "admin@example.test"
	loginPassword = "correct-horse-battery-staple"
	oldBearer     = "old-bearer"
	newBearer     = "new-bearer"
)

func TestLoginOperation(t *testing.T) {
	expiresAt := time.Date(2026, time.August, 17, 12, 0, 0, 0, time.UTC)
	oldCredential := auth.Credential{Token: oldBearer, ExpiresAt: expiresAt.Add(-time.Hour), Server: loginServer}
	newCredential := auth.Credential{Token: newBearer, ExpiresAt: expiresAt, Server: loginServer}
	storeErr := errors.New("keyring write failed")
	restoreErr := errors.New("keyring restore failed")

	for _, test := range []struct {
		name             string
		signIn           loginSignInResult
		store            loginCredentialStoreFake
		wantCode         string
		wantGets         int
		wantPuts         int
		wantSignOutCalls int
		wantStored       auth.Credential
		wantSignedIn     bool
	}{
		{
			name:         "replaces the prior credential only after successful sign-in",
			signIn:       successfulLoginSignIn(newCredential),
			store:        loginCredentialStoreFake{credential: oldCredential, exists: true},
			wantGets:     1,
			wantPuts:     1,
			wantStored:   newCredential,
			wantSignedIn: true,
		},
		{
			name: "preserves prior credential when sign-in fails",
			signIn: loginSignInResult{err: connect.NewError(
				connect.CodeUnauthenticated,
				errors.New("authentication failed"),
			)},
			store:      loginCredentialStoreFake{credential: oldCredential, exists: true},
			wantCode:   "unauthenticated",
			wantStored: oldCredential,
			wantGets:   1,
		},
		{
			name:   "restores prior credential before revoking a session after a changed failed write",
			signIn: successfulLoginSignIn(newCredential),
			store: loginCredentialStoreFake{
				credential: oldCredential,
				exists:     true,
				putErrors:  []error{storeErr, nil},
				putChanges: []bool{true, true},
			},
			wantCode:         "credential_store_unavailable",
			wantGets:         1,
			wantPuts:         2,
			wantSignOutCalls: 1,
			wantStored:       oldCredential,
		},
		{
			name:   "returns a credential-store failure when restoration fails but revocation is confirmed",
			signIn: successfulLoginSignIn(newCredential),
			store: loginCredentialStoreFake{
				credential: oldCredential,
				exists:     true,
				putErrors:  []error{storeErr, restoreErr},
				putChanges: []bool{true, false},
			},
			wantCode:         "credential_store_unavailable",
			wantGets:         1,
			wantPuts:         2,
			wantSignOutCalls: 1,
			wantStored:       newCredential,
		},
		{
			name:   "prioritizes unconfirmed revocation over a failed credential restoration",
			signIn: successfulLoginSignIn(newCredential),
			store: loginCredentialStoreFake{
				credential: oldCredential,
				exists:     true,
				putErrors:  []error{storeErr, restoreErr},
				putChanges: []bool{true, false},
			},
			wantCode:         "session_revocation_unconfirmed",
			wantGets:         1,
			wantPuts:         2,
			wantSignOutCalls: 1,
			wantStored:       newCredential,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			client := &loginAuthServiceFake{signIn: test.signIn}
			if test.wantCode == "session_revocation_unconfirmed" {
				client.signOut = loginSignOutResult{err: connect.NewError(connect.CodeUnavailable, errors.New("revocation unconfirmed"))}
			}
			store := test.store

			result, err := Login(t.Context(), LoginInput{
				Profile:  loginProfile,
				Server:   loginServer,
				Email:    loginEmail,
				Password: loginPassword,
			}, client, &store)

			if test.wantCode != "" {
				requireAppErrorCode(t, err, test.wantCode)
				if strings.Contains(err.Error(), oldBearer) || strings.Contains(err.Error(), newBearer) {
					t.Errorf("Login() error leaked bearer: %v", err)
				}
			} else {
				if err != nil {
					t.Fatalf("Login() error = %v", err)
				}
				if got, want := result.Profile, loginProfile; got != want {
					t.Errorf("result profile = %q, want %q", got, want)
				}
				if got, want := result.Server, loginServer; got != want {
					t.Errorf("result server = %q, want %q", got, want)
				}
				if !result.SignedIn {
					t.Error("result signed in = false, want true")
				}
				if got, want := result.CredentialExpiresAt, newCredential.ExpiresAt; !got.Equal(want) {
					t.Errorf("result credential expiry = %s, want %s", got, want)
				}
				encoded, marshalErr := json.Marshal(result)
				if marshalErr != nil {
					t.Fatalf("json.Marshal(result) error = %v", marshalErr)
				}
				if strings.Contains(string(encoded), newBearer) {
					t.Errorf("login result leaked bearer: %s", encoded)
				}
			}

			if got, want := client.signInCalls, 1; got != want {
				t.Errorf("SignIn calls = %d, want %d", got, want)
			}
			if client.signInRequest == nil {
				t.Fatal("SignIn did not receive a request")
			}
			if got := client.signInRequest.Msg; got.GetEmail() != loginEmail || got.GetPassword() != loginPassword {
				t.Errorf("SignIn request = %#v, want login email and password", got)
			}
			if got, want := store.getCalls, test.wantGets; got != want {
				t.Errorf("credential reads = %d, want %d", got, want)
			}
			if got, want := len(store.puts), test.wantPuts; got != want {
				t.Errorf("credential writes = %d, want %d", got, want)
			}
			if got := store.deleteCalls; got != 0 {
				t.Errorf("credential deletes = %d, want 0 while replacing a credential", got)
			}
			if len(store.puts) > 0 && store.puts[0] != newCredential {
				t.Errorf("first credential write = %#v, want new credential %#v", store.puts[0], newCredential)
			}
			if len(store.puts) > 1 && store.puts[1] != oldCredential {
				t.Errorf("restoration write = %#v, want prior credential %#v", store.puts[1], oldCredential)
			}
			if got, want := store.credential, test.wantStored; got != want {
				t.Errorf("stored credential = %#v, want %#v", got, want)
			}
			if got, want := client.signOutCalls, test.wantSignOutCalls; got != want {
				t.Errorf("SignOut calls = %d, want %d", got, want)
			}
			if client.signOutCalls == 1 && client.signOutRequest.Header().Get("Authorization") != "Bearer "+newBearer {
				t.Errorf("SignOut authorization = %q, want new bearer", client.signOutRequest.Header().Get("Authorization"))
			}
		})
	}
}

func TestCredentialMintingOperationsReplaceMalformedStoredRecord(t *testing.T) {
	expiresAt := time.Date(2026, time.August, 17, 12, 30, 0, 0, time.UTC)
	legacyRecord := `{"token":"old-bearer","expires_at":"2026-08-17T11:30:00Z"}`

	t.Run("login", func(t *testing.T) {
		backend := &mutableKeyringBackend{record: legacyRecord, found: true}
		credentials := auth.NewCredentialStore(backend, func(string) string { return "" })
		client := &loginAuthServiceFake{signIn: successfulLoginSignIn(auth.Credential{Token: newBearer, ExpiresAt: expiresAt})}

		result, err := Login(t.Context(), LoginInput{
			Profile:  loginProfile,
			Server:   loginServer,
			Email:    loginEmail,
			Password: loginPassword,
		}, client, credentials)

		if err != nil {
			t.Fatalf("Login() error = %v, want malformed credential replacement", err)
		}
		if !result.SignedIn {
			t.Error("Login() signed in = false after malformed credential replacement")
		}
		requireMalformedCredentialReplaced(t, backend, newBearer, expiresAt, loginServer)
	})

	t.Run("setup", func(t *testing.T) {
		backend := &mutableKeyringBackend{record: legacyRecord, found: true}
		credentials := auth.NewCredentialStore(backend, func(string) string { return "" })
		setupClient := &setupServiceFake{
			status: []setupStatusResult{{response: &apiv1.GetStatusResponse{}}},
			create: setupCreateResult{response: &apiv1.CreateAdministratorResponse{Administrator: setupAdministrator}},
		}
		authClient := &setupAuthServiceFake{signIn: successfulSetupSignIn(expiresAt)}

		result, err := Setup(t.Context(), testSetupInput(), setupClient, authClient, credentials)

		if err != nil {
			t.Fatalf("Setup() error = %v, want malformed credential replacement", err)
		}
		if !result.Initialized || !result.SignedIn {
			t.Errorf("Setup() result = %#v, want initialized and signed in", result)
		}
		requireMalformedCredentialReplaced(t, backend, setupBearer, expiresAt, setupServer)
	})
}

func TestCredentialMintingOperationsReturnTypedErrorWhenMalformedRecordCleanupFails(t *testing.T) {
	cleanupErr := errors.New("secret keyring cleanup detail")
	legacyRecord := `{"token":"old-bearer","expires_at":"2026-08-17T11:30:00Z"}`
	expiresAt := time.Date(2026, time.August, 17, 12, 30, 0, 0, time.UTC)

	t.Run("login", func(t *testing.T) {
		backend := &mutableKeyringBackend{record: legacyRecord, found: true, deleteErr: cleanupErr}
		credentials := auth.NewCredentialStore(backend, func(string) string { return "" })
		client := &loginAuthServiceFake{signIn: successfulLoginSignIn(auth.Credential{Token: newBearer, ExpiresAt: expiresAt})}

		_, err := Login(t.Context(), LoginInput{
			Profile:  loginProfile,
			Server:   loginServer,
			Email:    loginEmail,
			Password: loginPassword,
		}, client, credentials)

		requireAppErrorCode(t, err, "credential_cleanup_failed")
		if strings.Contains(err.Error(), cleanupErr.Error()) {
			t.Errorf("Login() error leaked cleanup detail: %v", err)
		}
		if client.signInCalls != 0 || backend.setCalls != 0 || backend.deleteCalls != 1 {
			t.Errorf("Login() mutation calls = sign-in:%d set:%d delete:%d, want 0, 0, 1", client.signInCalls, backend.setCalls, backend.deleteCalls)
		}
	})

	t.Run("setup", func(t *testing.T) {
		backend := &mutableKeyringBackend{record: legacyRecord, found: true, deleteErr: cleanupErr}
		credentials := auth.NewCredentialStore(backend, func(string) string { return "" })
		setupClient := &setupServiceFake{status: []setupStatusResult{{response: &apiv1.GetStatusResponse{}}}}
		authClient := &setupAuthServiceFake{signIn: successfulSetupSignIn(expiresAt)}

		_, err := Setup(t.Context(), testSetupInput(), setupClient, authClient, credentials)

		requireAppErrorCode(t, err, "credential_cleanup_failed")
		if strings.Contains(err.Error(), cleanupErr.Error()) {
			t.Errorf("Setup() error leaked cleanup detail: %v", err)
		}
		if setupClient.statusCalls != 0 || setupClient.createCalls != 0 || authClient.signInCalls != 0 || backend.setCalls != 0 || backend.deleteCalls != 1 {
			t.Errorf("Setup() mutation calls = status:%d create:%d sign-in:%d set:%d delete:%d, want 0, 0, 0, 0, 1", setupClient.statusCalls, setupClient.createCalls, authClient.signInCalls, backend.setCalls, backend.deleteCalls)
		}
	})
}

func TestStatusOperation(t *testing.T) {
	expiresAt := time.Date(2026, time.August, 17, 12, 0, 0, 0, time.UTC)
	storedCredential := auth.Credential{Token: oldBearer, ExpiresAt: expiresAt, Server: loginServer}
	injectedCredential := auth.Credential{Token: newBearer, Injected: true}
	rejected := connect.NewError(connect.CodeUnauthenticated, errors.New("credential rejected"))

	for _, test := range []struct {
		name            string
		input           StatusInput
		store           statusCredentialStoreFake
		currentUser     *apiv1.GetCurrentUserResponse
		currentUserErr  error
		wantCode        string
		wantSignedIn    bool
		wantDeleteCalls int
		wantUserCalls   int
		wantExpiry      time.Time
	}{
		{
			name:         "reports signed out when no credential exists",
			input:        matchingStatusInput(),
			store:        statusCredentialStoreFake{},
			wantSignedIn: false,
		},
		{
			name:          "reports the administrator and stored expiry for a valid credential",
			input:         matchingStatusInput(),
			store:         statusCredentialStoreFake{credential: storedCredential, exists: true},
			currentUser:   &apiv1.GetCurrentUserResponse{Administrator: setupAdministrator},
			wantSignedIn:  true,
			wantUserCalls: 1,
			wantExpiry:    expiresAt,
		},
		{
			name:           "leaves a rejected injected credential untouched",
			input:          matchingStatusInput(),
			store:          statusCredentialStoreFake{credential: injectedCredential, exists: true},
			currentUserErr: rejected,
			wantCode:       "unauthenticated",
			wantUserCalls:  1,
		},
		{
			name:            "deletes a rejected stored credential",
			input:           matchingStatusInput(),
			store:           statusCredentialStoreFake{credential: storedCredential, exists: true},
			currentUserErr:  rejected,
			wantCode:        "unauthenticated",
			wantDeleteCalls: 1,
			wantUserCalls:   1,
		},
		{
			name:  "reports invalid credential cleanup failure without exposing it",
			input: matchingStatusInput(),
			store: statusCredentialStoreFake{
				credential: storedCredential,
				exists:     true,
				deleteErr:  errors.New("keyring delete failed"),
			},
			currentUserErr:  rejected,
			wantCode:        "credential_cleanup_failed",
			wantDeleteCalls: 1,
			wantUserCalls:   1,
		},
		{
			name: "does not send a stored profile credential to a server override",
			input: StatusInput{
				Profile:       loginProfile,
				ProfileServer: loginServer,
				Server:        "https://override.example.test",
			},
			store:        statusCredentialStoreFake{credential: storedCredential, exists: true},
			wantSignedIn: false,
		},
		{
			name: "uses an injected credential on a server override",
			input: StatusInput{
				Profile:       loginProfile,
				ProfileServer: loginServer,
				Server:        "https://override.example.test",
			},
			store:         statusCredentialStoreFake{credential: injectedCredential, exists: true},
			currentUser:   &apiv1.GetCurrentUserResponse{Administrator: setupAdministrator},
			wantSignedIn:  true,
			wantUserCalls: 1,
		},
		{
			name:          "omits profile data when an explicit server has no selected profile",
			input:         StatusInput{Server: loginServer},
			store:         statusCredentialStoreFake{credential: injectedCredential, exists: true},
			currentUser:   &apiv1.GetCurrentUserResponse{Administrator: setupAdministrator},
			wantSignedIn:  true,
			wantUserCalls: 1,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			store := test.store
			client := &statusAuthServiceFake{currentUser: test.currentUser, currentUserErr: test.currentUserErr}

			result, err := Status(t.Context(), test.input, client, &store)

			if test.wantCode != "" {
				requireAppErrorCode(t, err, test.wantCode)
				if strings.Contains(err.Error(), oldBearer) || strings.Contains(err.Error(), newBearer) {
					t.Errorf("Status() error leaked bearer: %v", err)
				}
			} else {
				if err != nil {
					t.Fatalf("Status() error = %v", err)
				}
				if got, want := result.Server, test.input.Server; got != want {
					t.Errorf("result server = %q, want %q", got, want)
				}
				if got, want := result.Profile, test.input.Profile; got != want {
					t.Errorf("result profile = %q, want %q", got, want)
				}
				if got, want := result.SignedIn, test.wantSignedIn; got != want {
					t.Errorf("result signed in = %t, want %t", got, want)
				}
				if test.wantSignedIn && (result.Administrator == nil || result.Administrator.GetId() != setupAdministrator.GetId()) {
					t.Errorf("result administrator = %#v, want %#v", result.Administrator, setupAdministrator)
				}
				if got, want := result.CredentialExpiresAt, test.wantExpiry; (got == nil) != want.IsZero() || got != nil && !got.Equal(want) {
					t.Errorf("result credential expiry = %#v, want %s", got, want)
				}
			}
			if got, want := client.currentUserCalls, test.wantUserCalls; got != want {
				t.Errorf("GetCurrentUser calls = %d, want %d", got, want)
			}
			if got, want := store.deleteCalls, test.wantDeleteCalls; got != want {
				t.Errorf("credential deletes = %d, want %d", got, want)
			}
			if test.wantUserCalls == 1 && client.request.Header().Get("Authorization") != "Bearer "+test.store.credential.Token {
				t.Errorf("GetCurrentUser authorization = %q, want selected credential", client.request.Header().Get("Authorization"))
			}
		})
	}
}

func TestStatusDoesNotSendStoredBearerToDifferentCredentialServer(t *testing.T) {
	store := &statusCredentialStoreFake{
		credential: auth.Credential{
			Token:     oldBearer,
			ExpiresAt: time.Date(2026, time.August, 17, 12, 0, 0, 0, time.UTC),
			Server:    "https://other.nama.example.test",
		},
		exists: true,
	}
	client := &statusAuthServiceFake{currentUser: &apiv1.GetCurrentUserResponse{Administrator: setupAdministrator}}

	result, err := Status(t.Context(), matchingStatusInput(), client, store)

	if err != nil {
		t.Fatalf("Status() error = %v", err)
	}
	if result.SignedIn {
		t.Error("Status() reported signed in with a credential bound to a different server")
	}
	if got := client.currentUserCalls; got != 0 {
		t.Errorf("GetCurrentUser calls = %d, want 0 for a credential bound to a different server", got)
	}
	if client.request != nil && client.request.Header().Get("Authorization") != "" {
		t.Errorf("GetCurrentUser received stored bearer %q for a different server", client.request.Header().Get("Authorization"))
	}
}

func TestCredentialMintingOperationsRejectInjectedCredentialBeforeMutation(t *testing.T) {
	injected := auth.Credential{Token: "injected-bearer", Injected: true}

	t.Run("login", func(t *testing.T) {
		client := &loginAuthServiceFake{signIn: successfulLoginSignIn(auth.Credential{Token: newBearer, ExpiresAt: time.Date(2026, time.August, 17, 12, 0, 0, 0, time.UTC)})}
		store := &loginCredentialStoreFake{credential: injected, exists: true}

		_, err := Login(t.Context(), LoginInput{
			Profile: loginProfile, Server: loginServer, Email: loginEmail, Password: loginPassword,
		}, client, store)

		requireAppErrorCode(t, err, "invalid_argument")
		if got := client.signInCalls; got != 0 {
			t.Errorf("SignIn calls = %d, want 0 with NAMA_TOKEN injected", got)
		}
		if got := store.getCalls; got != 1 {
			t.Errorf("credential reads = %d, want 1 to detect NAMA_TOKEN injection", got)
		}
		if got := len(store.puts); got != 0 {
			t.Errorf("credential writes = %d, want 0 with NAMA_TOKEN injected", got)
		}
		if got := store.deleteCalls; got != 0 {
			t.Errorf("credential deletes = %d, want 0 with NAMA_TOKEN injected", got)
		}
	})

	t.Run("setup", func(t *testing.T) {
		setupClient := &setupServiceFake{status: []setupStatusResult{{response: &apiv1.GetStatusResponse{}}}}
		authClient := &setupAuthServiceFake{signIn: successfulSetupSignIn(time.Date(2026, time.August, 17, 12, 0, 0, 0, time.UTC))}
		store := &setupCredentialStoreFake{credential: injected, exists: true}

		_, err := Setup(t.Context(), testSetupInput(), setupClient, authClient, store)

		requireAppErrorCode(t, err, "invalid_argument")
		if got := setupClient.createCalls; got != 0 {
			t.Errorf("CreateAdministrator calls = %d, want 0 with NAMA_TOKEN injected", got)
		}
		if got := authClient.signInCalls; got != 0 {
			t.Errorf("SignIn calls = %d, want 0 with NAMA_TOKEN injected", got)
		}
		if got := authClient.signOutCalls; got != 0 {
			t.Errorf("SignOut calls = %d, want 0 with NAMA_TOKEN injected", got)
		}
		if got := store.getCalls; got != 1 {
			t.Errorf("credential reads = %d, want 1 to detect NAMA_TOKEN injection", got)
		}
		if got := store.putCalls; got != 0 {
			t.Errorf("credential writes = %d, want 0 with NAMA_TOKEN injected", got)
		}
		if got := store.deleteCalls; got != 0 {
			t.Errorf("credential deletes = %d, want 0 with NAMA_TOKEN injected", got)
		}
	})
}

func TestStatusResolvesInjectionBeforeIneligibleStoredCredentials(t *testing.T) {
	expiresAt := time.Date(2026, time.August, 17, 12, 0, 0, 0, time.UTC)
	record, err := json.Marshal(auth.Credential{Token: oldBearer, ExpiresAt: expiresAt, Server: loginServer})
	if err != nil {
		t.Fatalf("encoding stored credential fixture failed: %v", err)
	}

	for _, test := range []struct {
		name          string
		input         StatusInput
		injectedToken string
		wantSignedIn  bool
		wantUserCalls int
	}{
		{
			name:         "no selected profile",
			input:        StatusInput{Server: loginServer},
			wantSignedIn: false,
		},
		{
			name: "stored profile credential on a server override",
			input: StatusInput{
				Profile:       loginProfile,
				ProfileServer: loginServer,
				Server:        "https://override.example.test",
			},
			wantSignedIn: false,
		},
		{
			name:          "injected credential without a selected profile",
			input:         StatusInput{Server: loginServer},
			injectedToken: newBearer,
			wantSignedIn:  true,
			wantUserCalls: 1,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			backend := &statusKeyringBackend{record: string(record), found: true}
			credentials := auth.NewCredentialStore(backend, func(name string) string {
				if name == "NAMA_TOKEN" {
					return test.injectedToken
				}
				return ""
			})
			client := &statusAuthServiceFake{currentUser: &apiv1.GetCurrentUserResponse{Administrator: setupAdministrator}}

			result, err := Status(t.Context(), test.input, client, credentials)

			if err != nil {
				t.Fatalf("Status() error = %v", err)
			}
			if got := result.SignedIn; got != test.wantSignedIn {
				t.Errorf("signed in = %t, want %t", got, test.wantSignedIn)
			}
			if got := backend.getCalls; got != 0 {
				t.Errorf("native keyring reads = %d, want 0", got)
			}
			if got := client.currentUserCalls; got != test.wantUserCalls {
				t.Errorf("GetCurrentUser calls = %d, want %d", got, test.wantUserCalls)
			}
		})
	}
}

func TestLoginRejectsMalformedAdministratorsBeforeCredentialMutation(t *testing.T) {
	expiresAt := time.Date(2026, time.August, 17, 12, 0, 0, 0, time.UTC)

	for _, test := range []struct {
		name          string
		administrator *apiv1.Administrator
	}{
		{name: "missing ID", administrator: &apiv1.Administrator{DisplayName: "Nama Admin", Email: loginEmail}},
		{name: "missing display name", administrator: &apiv1.Administrator{Id: "administrator-1", Email: loginEmail}},
		{name: "missing email", administrator: &apiv1.Administrator{Id: "administrator-1", DisplayName: "Nama Admin"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			client := &loginAuthServiceFake{signIn: loginSignInResult{response: &apiv1.SignInResponse{
				Administrator: test.administrator,
				Credential:    &apiv1.BearerCredential{Token: newBearer, ExpiresAt: timestamppb.New(expiresAt)},
			}}}
			store := &loginCredentialStoreFake{credential: auth.Credential{Token: oldBearer, ExpiresAt: expiresAt, Server: loginServer}, exists: true}

			_, err := Login(t.Context(), LoginInput{
				Profile: loginProfile, Server: loginServer, Email: loginEmail, Password: loginPassword,
			}, client, store)

			requireAppErrorCode(t, err, "unexpected_failure")
			if strings.Contains(err.Error(), newBearer) {
				t.Errorf("Login() error leaked bearer: %v", err)
			}
			if got := client.signInCalls; got != 1 {
				t.Errorf("SignIn calls = %d, want 1", got)
			}
			if got := store.getCalls; got != 1 {
				t.Errorf("credential reads = %d, want 1 to reject an injected credential before sign-in", got)
			}
			if got := len(store.puts); got != 0 {
				t.Errorf("credential writes = %d, want 0 after malformed administrator", got)
			}
			if got := store.deleteCalls; got != 0 {
				t.Errorf("credential deletes = %d, want 0 after malformed administrator", got)
			}
			if got := client.signOutCalls; got != 1 {
				t.Errorf("SignOut calls = %d, want 1 for a malformed response with a usable bearer", got)
			}
			if client.signOutRequest == nil {
				t.Error("SignOut did not receive a request")
			} else if got := client.signOutRequest.Header().Get("Authorization"); got != "Bearer "+newBearer {
				t.Errorf("SignOut authorization = %q, want new bearer", got)
			}
		})
	}
}

func TestLoginPrioritizesUnconfirmedRevocationAfterMalformedSignInResponse(t *testing.T) {
	expiresAt := time.Date(2026, time.August, 17, 12, 0, 0, 0, time.UTC)
	client := &loginAuthServiceFake{
		signIn: loginSignInResult{response: &apiv1.SignInResponse{
			Administrator: &apiv1.Administrator{DisplayName: "Nama Admin", Email: loginEmail},
			Credential:    &apiv1.BearerCredential{Token: newBearer, ExpiresAt: timestamppb.New(expiresAt)},
		}},
		signOut: loginSignOutResult{err: connect.NewError(connect.CodeUnavailable, errors.New("revocation unavailable"))},
	}
	previous := auth.Credential{Token: oldBearer, ExpiresAt: expiresAt.Add(-time.Hour), Server: loginServer}
	store := &loginCredentialStoreFake{credential: previous, exists: true}

	_, err := Login(t.Context(), LoginInput{
		Profile: loginProfile, Server: loginServer, Email: loginEmail, Password: loginPassword,
	}, client, store)

	requireAppErrorCode(t, err, "session_revocation_unconfirmed")
	if strings.Contains(err.Error(), newBearer) {
		t.Errorf("Login() error leaked bearer: %v", err)
	}
	if got := client.signOutCalls; got != 1 {
		t.Errorf("SignOut calls = %d, want 1", got)
	}
	if client.signOutRequest == nil {
		t.Error("SignOut did not receive a request")
	} else if got := client.signOutRequest.Header().Get("Authorization"); got != "Bearer "+newBearer {
		t.Errorf("SignOut authorization = %q, want new bearer", got)
	}
	if got := len(store.puts); got != 0 {
		t.Errorf("credential writes = %d, want 0 after malformed sign-in response", got)
	}
	if got := store.credential; got != previous {
		t.Errorf("stored credential = %#v, want untouched prior credential %#v", got, previous)
	}
}

func TestStatusRejectsMalformedAdministratorsWithoutCredentialCleanup(t *testing.T) {
	expiresAt := time.Date(2026, time.August, 17, 12, 0, 0, 0, time.UTC)

	for _, test := range []struct {
		name          string
		administrator *apiv1.Administrator
	}{
		{name: "missing ID", administrator: &apiv1.Administrator{DisplayName: "Nama Admin", Email: loginEmail}},
		{name: "missing display name", administrator: &apiv1.Administrator{Id: "administrator-1", Email: loginEmail}},
		{name: "missing email", administrator: &apiv1.Administrator{Id: "administrator-1", DisplayName: "Nama Admin"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			store := &statusCredentialStoreFake{credential: auth.Credential{Token: oldBearer, ExpiresAt: expiresAt, Server: loginServer}, exists: true}
			client := &statusAuthServiceFake{currentUser: &apiv1.GetCurrentUserResponse{Administrator: test.administrator}}

			_, err := Status(t.Context(), matchingStatusInput(), client, store)

			requireAppErrorCode(t, err, "unexpected_failure")
			if got := store.getCalls; got != 1 {
				t.Errorf("credential reads = %d, want 1", got)
			}
			if got := client.currentUserCalls; got != 1 {
				t.Errorf("GetCurrentUser calls = %d, want 1", got)
			}
			if got := store.deleteCalls; got != 0 {
				t.Errorf("credential deletes = %d, want 0 for malformed response", got)
			}
		})
	}
}

func TestAuthenticationOperationsPreserveUnknownUnauthenticatedCode(t *testing.T) {
	unauthenticated := connect.NewWireError(connect.CodeUnauthenticated, errors.New("server rejected the credential"))

	t.Run("login", func(t *testing.T) {
		client := &loginAuthServiceFake{signIn: loginSignInResult{err: unauthenticated}}
		store := &loginCredentialStoreFake{credential: auth.Credential{Token: oldBearer, Server: loginServer}, exists: true}

		_, err := Login(t.Context(), LoginInput{
			Profile: loginProfile, Server: loginServer, Email: loginEmail, Password: loginPassword,
		}, client, store)

		requireAppErrorCode(t, err, "unauthenticated")
		if got := client.signInCalls; got != 1 {
			t.Errorf("SignIn calls = %d, want 1", got)
		}
		if got := store.getCalls; got != 1 {
			t.Errorf("credential reads = %d, want 1 to reject an injected credential before sign-in", got)
		}
	})

	t.Run("status", func(t *testing.T) {
		store := &statusCredentialStoreFake{credential: auth.Credential{Token: oldBearer, Server: loginServer}, exists: true}
		client := &statusAuthServiceFake{currentUserErr: unauthenticated}

		_, err := Status(t.Context(), matchingStatusInput(), client, store)

		requireAppErrorCode(t, err, "unauthenticated")
		if got := client.currentUserCalls; got != 1 {
			t.Errorf("GetCurrentUser calls = %d, want 1", got)
		}
		if got := store.deleteCalls; got != 1 {
			t.Errorf("credential deletes = %d, want 1 for rejected stored credential", got)
		}
	})
}

func successfulLoginSignIn(credential auth.Credential) loginSignInResult {
	return loginSignInResult{response: &apiv1.SignInResponse{
		Administrator: setupAdministrator,
		Credential: &apiv1.BearerCredential{
			Token:     credential.Token,
			ExpiresAt: timestamppb.New(credential.ExpiresAt),
		},
	}}
}

func matchingStatusInput() StatusInput {
	return StatusInput{Profile: loginProfile, ProfileServer: loginServer, Server: loginServer}
}

type loginSignInResult struct {
	response *apiv1.SignInResponse
	err      error
}

type loginSignOutResult struct {
	response *apiv1.SignOutResponse
	err      error
}

type loginAuthServiceFake struct {
	apiv1.UnimplementedAuthServiceHandler
	signIn         loginSignInResult
	signOut        loginSignOutResult
	signInCalls    int
	signOutCalls   int
	signInRequest  *connect.Request[apiv1.SignInRequest]
	signOutRequest *connect.Request[apiv1.SignOutRequest]
}

func (f *loginAuthServiceFake) SignIn(_ context.Context, request *connect.Request[apiv1.SignInRequest]) (*connect.Response[apiv1.SignInResponse], error) {
	f.signInCalls++
	f.signInRequest = request
	if f.signIn.err != nil {
		return nil, f.signIn.err
	}
	return connect.NewResponse(f.signIn.response), nil
}

func (f *loginAuthServiceFake) GetCurrentUser(context.Context, *connect.Request[apiv1.GetCurrentUserRequest]) (*connect.Response[apiv1.GetCurrentUserResponse], error) {
	return nil, errors.New("unexpected GetCurrentUser call")
}

func (f *loginAuthServiceFake) SignOut(_ context.Context, request *connect.Request[apiv1.SignOutRequest]) (*connect.Response[apiv1.SignOutResponse], error) {
	f.signOutCalls++
	f.signOutRequest = request
	if f.signOut.err != nil {
		return nil, f.signOut.err
	}
	return connect.NewResponse(f.signOut.response), nil
}

type loginCredentialStoreFake struct {
	credential  auth.Credential
	exists      bool
	getCalls    int
	deleteCalls int
	putErrors   []error
	putChanges  []bool
	puts        []auth.Credential
}

func (f *loginCredentialStoreFake) Get(context.Context, string) (auth.Credential, bool, error) {
	f.getCalls++
	return f.credential, f.exists, nil
}

func (f *loginCredentialStoreFake) Put(_ context.Context, _ string, credential auth.Credential) error {
	index := len(f.puts)
	f.puts = append(f.puts, credential)
	if index >= len(f.putChanges) || f.putChanges[index] {
		f.credential = credential
		f.exists = true
	}
	if index < len(f.putErrors) {
		return f.putErrors[index]
	}
	return nil
}

func (f *loginCredentialStoreFake) Delete(context.Context, string) error {
	f.deleteCalls++
	return nil
}

type statusAuthServiceFake struct {
	apiv1.UnimplementedAuthServiceHandler
	currentUser      *apiv1.GetCurrentUserResponse
	currentUserErr   error
	currentUserCalls int
	request          *connect.Request[apiv1.GetCurrentUserRequest]
}

func (*statusAuthServiceFake) SignIn(context.Context, *connect.Request[apiv1.SignInRequest]) (*connect.Response[apiv1.SignInResponse], error) {
	return nil, errors.New("unexpected SignIn call")
}

func (f *statusAuthServiceFake) GetCurrentUser(_ context.Context, request *connect.Request[apiv1.GetCurrentUserRequest]) (*connect.Response[apiv1.GetCurrentUserResponse], error) {
	f.currentUserCalls++
	f.request = request
	if f.currentUserErr != nil {
		return nil, f.currentUserErr
	}
	return connect.NewResponse(f.currentUser), nil
}

func (*statusAuthServiceFake) SignOut(context.Context, *connect.Request[apiv1.SignOutRequest]) (*connect.Response[apiv1.SignOutResponse], error) {
	return nil, errors.New("unexpected SignOut call")
}

type statusCredentialStoreFake struct {
	credential  auth.Credential
	exists      bool
	getErr      error
	deleteErr   error
	getCalls    int
	deleteCalls int
}

func (f *statusCredentialStoreFake) Get(context.Context, string) (auth.Credential, bool, error) {
	f.getCalls++
	return f.credential, f.exists, f.getErr
}

func (*statusCredentialStoreFake) Put(context.Context, string, auth.Credential) error {
	return errors.New("unexpected Put call")
}

func (f *statusCredentialStoreFake) Delete(context.Context, string) error {
	f.deleteCalls++
	if f.deleteErr != nil {
		return f.deleteErr
	}
	f.credential = auth.Credential{}
	f.exists = false
	return nil
}

type statusKeyringBackend struct {
	record   string
	found    bool
	getCalls int
}

func (f *statusKeyringBackend) Get(string, string) (string, bool, error) {
	f.getCalls++
	return f.record, f.found, nil
}

func (*statusKeyringBackend) Set(string, string, string) error {
	return errors.New("unexpected keyring write")
}

func (*statusKeyringBackend) Delete(string, string) error {
	return errors.New("unexpected keyring delete")
}

type mutableKeyringBackend struct {
	record      string
	found       bool
	deleteErr   error
	setCalls    int
	deleteCalls int
}

func (f *mutableKeyringBackend) Get(string, string) (string, bool, error) {
	return f.record, f.found, nil
}

func (f *mutableKeyringBackend) Set(_, _, value string) error {
	f.setCalls++
	f.record = value
	f.found = true
	return nil
}

func (f *mutableKeyringBackend) Delete(string, string) error {
	f.deleteCalls++
	if f.deleteErr != nil {
		return f.deleteErr
	}
	f.record = ""
	f.found = false
	return nil
}

func requireMalformedCredentialReplaced(t *testing.T, backend *mutableKeyringBackend, token string, expiresAt time.Time, server string) {
	t.Helper()
	if backend.deleteCalls != 1 || backend.setCalls != 1 {
		t.Fatalf("keyring calls = delete:%d set:%d, want 1, 1", backend.deleteCalls, backend.setCalls)
	}
	var credential auth.Credential
	if err := json.Unmarshal([]byte(backend.record), &credential); err != nil {
		t.Fatalf("replacement keyring record is not credential JSON: %v", err)
	}
	if credential.Token != token || !credential.ExpiresAt.Equal(expiresAt) || credential.Server != server {
		t.Errorf("replacement credential = %#v, want token %q, expiry %s, server %q", credential, token, expiresAt, server)
	}
}
