package auth

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"time"

	"github.com/electather/nama/apps/cli/internal/config"

	keyring "github.com/zalando/go-keyring"
)

const keyringService = "nama-cli"

// ErrCredentialCleanupFailed identifies a failed attempt to remove an invalid stored credential.
var ErrCredentialCleanupFailed = errors.New("invalid credential cleanup failed")

var errInvalidCredential = errors.New("invalid credential record")

// Credential is the bearer material kept in the native credential store.
type Credential struct {
	Token     string    `json:"token"`
	ExpiresAt time.Time `json:"expires_at"`
	Server    string    `json:"server"`
	Injected  bool      `json:"-"`
}

// CredentialStore keeps credentials for named server profiles.
type CredentialStore interface {
	Get(context.Context, string) (Credential, bool, error)
	Put(context.Context, string, Credential) error
	Delete(context.Context, string) error
}

// KeyringBackend is the minimal native credential-store boundary.
type KeyringBackend interface {
	Get(service, account string) (string, bool, error)
	Set(service, account, value string) error
	Delete(service, account string) error
}

// NativeKeyring adapts the operating system credential store.
type NativeKeyring struct{}

func (NativeKeyring) Get(service, account string) (string, bool, error) {
	value, err := keyring.Get(service, account)
	if errors.Is(err, keyring.ErrNotFound) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return value, true, nil
}

func (NativeKeyring) Set(service, account, value string) error {
	return keyring.Set(service, account, value)
}

func (NativeKeyring) Delete(service, account string) error {
	err := keyring.Delete(service, account)
	if errors.Is(err, keyring.ErrNotFound) {
		return nil
	}
	return err
}

type credentialStore struct {
	backend KeyringBackend
	getenv  func(string) string
}

// NewCredentialStore constructs a profile-scoped native credential store.
func NewCredentialStore(backend KeyringBackend, getenv func(string) string) CredentialStore {
	return credentialStore{backend: backend, getenv: getenv}
}

func (s credentialStore) Get(ctx context.Context, profile string) (Credential, bool, error) {
	if credential, found := s.Injected(); found {
		return credential, true, nil
	}

	record, found, err := s.backend.Get(keyringService, profile)
	if err != nil || !found {
		return Credential{}, false, err
	}

	credential, err := decodeCredential(record)
	if err != nil {
		if cleanupErr := s.Delete(ctx, profile); cleanupErr != nil {
			return Credential{}, false, errors.Join(ErrCredentialCleanupFailed, cleanupErr)
		}
		return Credential{}, false, nil
	}
	return credential, true, nil
}

// Injected returns the process-local credential, if NAMA_TOKEN is set.
func (s credentialStore) Injected() (Credential, bool) {
	if token := s.injectedToken(); token != "" {
		return Credential{Token: token, Injected: true}, true
	}
	return Credential{}, false
}

func (s credentialStore) Put(_ context.Context, profile string, credential Credential) error {
	if s.injectedToken() != "" {
		return nil
	}

	record, err := marshalCredential(credential)
	if err != nil {
		return err
	}
	return s.backend.Set(keyringService, profile, record)
}

func (s credentialStore) Delete(_ context.Context, profile string) error {
	return s.backend.Delete(keyringService, profile)
}

func (s credentialStore) injectedToken() string {
	if s.getenv == nil {
		return ""
	}
	return s.getenv("NAMA_TOKEN")
}

func marshalCredential(credential Credential) (string, error) {
	credential, err := canonicalCredential(credential)
	if err != nil {
		return "", err
	}

	record, err := json.Marshal(credential)
	if err != nil {
		return "", errInvalidCredential
	}
	return string(record), nil
}

func decodeCredential(record string) (Credential, error) {
	decoder := json.NewDecoder(strings.NewReader(record))
	decoder.DisallowUnknownFields()

	var credential Credential
	if err := decoder.Decode(&credential); err != nil {
		return Credential{}, errInvalidCredential
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return Credential{}, errInvalidCredential
	}
	return canonicalCredential(credential)
}

func canonicalCredential(credential Credential) (Credential, error) {
	if credential.Token == "" || credential.ExpiresAt.IsZero() {
		return Credential{}, errInvalidCredential
	}

	server, _, err := config.NormalizeServerURL(credential.Server)
	if err != nil || server != credential.Server {
		return Credential{}, errInvalidCredential
	}

	credential.ExpiresAt = credential.ExpiresAt.UTC()
	return credential, nil
}
