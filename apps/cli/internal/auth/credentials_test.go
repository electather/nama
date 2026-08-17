package auth

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

const nativeCredentialServer = "https://nama.example.test/api"

func TestCredentialStoreGet(t *testing.T) {
	expiresAt := time.Date(2026, time.August, 17, 12, 0, 0, 0, time.UTC)
	backendFailure := errors.New("keyring unavailable")

	tests := []struct {
		name         string
		envToken     string
		backend      fakeKeyring
		wantFound    bool
		wantInjected bool
		wantExpiry   time.Time
		wantServer   string
		wantErr      error
		wantGets     int
	}{
		{
			name:     "NAMA_TOKEN takes precedence without keyring lookup",
			envToken: "injected-bearer",
			backend: fakeKeyring{
				record: "not-valid-json",
				found:  true,
			},
			wantFound:    true,
			wantInjected: true,
		},
		{
			name: "stored record uses profile account and nama-cli service",
			backend: fakeKeyring{
				record: encodeCredential(t, Credential{Token: "stored-bearer", ExpiresAt: expiresAt, Server: nativeCredentialServer}),
				found:  true,
			},
			wantFound:  true,
			wantExpiry: expiresAt,
			wantServer: nativeCredentialServer,
			wantGets:   1,
		},
		{
			name:      "missing record is signed out",
			backend:   fakeKeyring{},
			wantFound: false,
			wantGets:  1,
		},
		{
			name:     "backend failure is operational error",
			backend:  fakeKeyring{getErr: backendFailure},
			wantErr:  backendFailure,
			wantGets: 1,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			backend := test.backend
			store := NewCredentialStore(&backend, func(name string) string {
				if name == "NAMA_TOKEN" {
					return test.envToken
				}
				return ""
			})

			credential, found, err := store.Get(t.Context(), "production")
			if !errors.Is(err, test.wantErr) {
				t.Fatal("credential lookup returned the wrong error")
			}
			if found != test.wantFound {
				t.Fatal("credential lookup returned the wrong signed-in state")
			}
			if credential.Injected != test.wantInjected {
				t.Fatal("credential lookup returned the wrong provenance")
			}
			if len(backend.gets) != test.wantGets {
				t.Fatal("credential lookup used the keyring unexpectedly")
			}
			if len(backend.gets) == 1 {
				if got := backend.gets[0]; got.service != "nama-cli" || got.account != "production" {
					t.Fatal("credential lookup used the wrong keyring identity")
				}
			}
			if test.envToken != "" {
				requireSameSecret(t, credential.Token, test.envToken, "NAMA_TOKEN did not take precedence")
				if !credential.ExpiresAt.IsZero() {
					t.Fatal("injected credential unexpectedly has a stored expiry")
				}
			}
			if !test.wantExpiry.IsZero() && !credential.ExpiresAt.Equal(test.wantExpiry) {
				t.Fatal("stored credential expiry did not round-trip")
			}
			if test.wantServer != "" && credential.Server != test.wantServer {
				t.Fatal("stored credential server did not round-trip")
			}
		})
	}
}

func TestCredentialStorePutEncodesBearerExpiryAndCanonicalServer(t *testing.T) {
	expiresAt := time.Date(2026, time.August, 17, 12, 30, 0, 0, time.UTC)
	credential := Credential{Token: "stored-bearer", ExpiresAt: expiresAt, Server: nativeCredentialServer}
	backend := &fakeKeyring{}
	store := NewCredentialStore(backend, func(string) string { return "" })

	if err := store.Put(t.Context(), "production", credential); err != nil {
		t.Fatal("storing the credential returned an error")
	}
	if len(backend.sets) != 1 {
		t.Fatal("storing the credential did not write exactly one keyring record")
	}
	if got := backend.sets[0]; got.service != "nama-cli" || got.account != "production" {
		t.Fatal("stored credential used the wrong keyring identity")
	}

	var record map[string]json.RawMessage
	if err := json.Unmarshal([]byte(backend.sets[0].value), &record); err != nil {
		t.Fatal("stored keyring value was not JSON")
	}
	if len(record) != 3 || record["token"] == nil || record["expires_at"] == nil || record["server"] == nil {
		t.Fatal("stored keyring value does not contain exactly bearer, expiry, and canonical server")
	}
	var decoded Credential
	if err := json.Unmarshal([]byte(backend.sets[0].value), &decoded); err != nil {
		t.Fatal("stored keyring value could not be decoded")
	}
	requireSameSecret(t, decoded.Token, credential.Token, "stored bearer did not round-trip")
	if !decoded.ExpiresAt.Equal(expiresAt) {
		t.Fatal("stored expiry did not round-trip")
	}
	if decoded.Server != nativeCredentialServer {
		t.Fatal("stored canonical server did not round-trip")
	}
}

func TestCredentialStoreDiscardsLegacyMalformedAndUnboundServerRecords(t *testing.T) {
	expiresAt := "2026-08-17T12:30:00Z"

	for _, test := range []struct {
		name   string
		record string
	}{
		{
			name:   "malformed JSON",
			record: "not-valid-json",
		},
		{
			name:   "legacy two-field record",
			record: `{"token":"stored-bearer","expires_at":"` + expiresAt + `"}`,
		},
		{
			name:   "empty server",
			record: `{"token":"stored-bearer","expires_at":"` + expiresAt + `","server":""}`,
		},
		{
			name:   "malformed server",
			record: `{"token":"stored-bearer","expires_at":"` + expiresAt + `","server":"not a URL"}`,
		},
		{
			name:   "noncanonical server",
			record: `{"token":"stored-bearer","expires_at":"` + expiresAt + `","server":"https://NAMA.EXAMPLE.TEST/api/"}`,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			backend := &fakeKeyring{record: test.record, found: true}
			store := NewCredentialStore(backend, func(string) string { return "" })

			credential, found, err := store.Get(t.Context(), "production")

			if err != nil {
				t.Fatalf("Get() error = %v, want invalid record cleanup", err)
			}
			if found {
				t.Errorf("Get() found = true with invalid record: %#v", credential)
			}
			if credential.Token != "" {
				t.Error("Get() exposed a bearer from an invalid record")
			}
			if len(backend.deletes) != 1 {
				t.Fatalf("keyring deletes = %d, want 1 invalid record cleanup", len(backend.deletes))
			}
			if backend.found {
				t.Error("invalid credential record remains after successful cleanup")
			}
		})
	}
}

func TestCredentialStoreInvalidRecordCleanupFailureIsOperational(t *testing.T) {
	cleanupErr := errors.New("keyring delete failed")
	backend := &fakeKeyring{record: "not-valid-json", found: true, deleteErr: cleanupErr}
	store := NewCredentialStore(backend, func(string) string { return "" })

	credential, found, err := store.Get(t.Context(), "production")

	if !errors.Is(err, cleanupErr) {
		t.Fatalf("Get() error = %v, want keyring cleanup error", err)
	}
	if found || credential.Token != "" {
		t.Errorf("Get() = (%#v, %t), want no usable credential after cleanup failure", credential, found)
	}
	if len(backend.deletes) != 1 {
		t.Errorf("keyring deletes = %d, want 1 cleanup attempt", len(backend.deletes))
	}
}

func TestCredentialStorePutRejectsCredentialWithoutCanonicalServer(t *testing.T) {
	backend := &fakeKeyring{}
	store := NewCredentialStore(backend, func(string) string { return "" })

	err := store.Put(t.Context(), "production", Credential{
		Token:     "stored-bearer",
		ExpiresAt: time.Date(2026, time.August, 17, 12, 30, 0, 0, time.UTC),
	})

	if !errors.Is(err, errInvalidCredential) {
		t.Fatalf("Put() error = %v, want invalid credential record", err)
	}
	if len(backend.sets) != 0 {
		t.Error("Put() wrote a credential record without a canonical server")
	}
}

func TestCredentialStoreWriteAndDeleteFailuresAreOperational(t *testing.T) {
	backendFailure := errors.New("keyring unavailable")

	for _, test := range []struct {
		name string
		run  func(context.Context, CredentialStore) error
	}{
		{
			name: "write",
			run: func(ctx context.Context, store CredentialStore) error {
				return store.Put(ctx, "production", Credential{Token: "stored-bearer", ExpiresAt: time.Now(), Server: nativeCredentialServer})
			},
		},
		{
			name: "delete",
			run: func(ctx context.Context, store CredentialStore) error {
				return store.Delete(ctx, "production")
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			backend := &fakeKeyring{setErr: backendFailure, deleteErr: backendFailure}
			store := NewCredentialStore(backend, func(string) string { return "" })

			if !errors.Is(test.run(t.Context(), store), backendFailure) {
				t.Fatal("keyring failure was not returned as an operational error")
			}
		})
	}
}

func TestCredentialStoreSkipsWriteButDeletesStoredRecordWhileNAMA_TOKENIsInjected(t *testing.T) {
	backend := &fakeKeyring{
		record: encodeCredential(t, Credential{Token: "stored-bearer", ExpiresAt: time.Date(2026, time.August, 17, 12, 0, 0, 0, time.UTC), Server: nativeCredentialServer}),
		found:  true,
	}
	store := NewCredentialStore(backend, func(name string) string {
		if name == "NAMA_TOKEN" {
			return "injected-bearer"
		}
		return ""
	})

	if err := store.Put(t.Context(), "production", Credential{Token: "replacement-bearer", ExpiresAt: time.Now(), Server: nativeCredentialServer}); err != nil {
		t.Fatal("storing with NAMA_TOKEN injected returned an error")
	}
	if got := len(backend.sets); got != 0 {
		t.Errorf("keyring writes = %d, want 0 while NAMA_TOKEN is injected", got)
	}

	if err := store.Delete(t.Context(), "production"); err != nil {
		t.Fatal("deleting the stored credential with NAMA_TOKEN injected returned an error")
	}
	if got := len(backend.deletes); got != 1 {
		t.Fatalf("keyring deletes = %d, want 1 while NAMA_TOKEN is injected", got)
	}
	if got := backend.deletes[0]; got.service != "nama-cli" || got.account != "production" {
		t.Errorf("keyring delete = %#v, want nama-cli/production", got)
	}
	if backend.found {
		t.Error("stored keyring credential remains after deletion with NAMA_TOKEN injected")
	}
}

func TestCredentialStoreDeleteRemovesStoredRecord(t *testing.T) {
	backend := &fakeKeyring{record: encodeCredential(t, Credential{Token: "stored-bearer", ExpiresAt: time.Now(), Server: nativeCredentialServer}), found: true}
	store := NewCredentialStore(backend, func(string) string { return "" })

	if err := store.Delete(t.Context(), "production"); err != nil {
		t.Fatal("deleting the stored credential returned an error")
	}
	if len(backend.deletes) != 1 {
		t.Fatal("deleting the stored credential did not remove one keyring record")
	}
	if got := backend.deletes[0]; got.service != "nama-cli" || got.account != "production" {
		t.Fatal("deleting the stored credential used the wrong keyring identity")
	}
}

type keyringCall struct {
	service string
	account string
	value   string
}

type fakeKeyring struct {
	record    string
	found     bool
	getErr    error
	setErr    error
	deleteErr error
	gets      []keyringCall
	sets      []keyringCall
	deletes   []keyringCall
}

func (f *fakeKeyring) Get(service, account string) (string, bool, error) {
	f.gets = append(f.gets, keyringCall{service: service, account: account})
	if f.getErr != nil {
		return "", false, f.getErr
	}
	return f.record, f.found, nil
}

func (f *fakeKeyring) Set(service, account, value string) error {
	f.sets = append(f.sets, keyringCall{service: service, account: account, value: value})
	if f.setErr != nil {
		return f.setErr
	}
	f.record = value
	f.found = true
	return nil
}

func (f *fakeKeyring) Delete(service, account string) error {
	f.deletes = append(f.deletes, keyringCall{service: service, account: account})
	if f.deleteErr != nil {
		return f.deleteErr
	}
	f.record = ""
	f.found = false
	return nil
}

func encodeCredential(t *testing.T, credential Credential) string {
	t.Helper()
	encoded, err := json.Marshal(credential)
	if err != nil {
		t.Fatal("encoding a credential fixture failed")
	}
	return string(encoded)
}

func requireSameSecret(t *testing.T, got, want, message string) {
	t.Helper()
	if got != want {
		t.Fatal(message)
	}
}
