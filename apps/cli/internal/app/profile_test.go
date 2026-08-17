package app_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/electather/nama/apps/cli/internal/app"
	"github.com/electather/nama/apps/cli/internal/config"
)

type testCredentialDeleter struct {
	deleted  []string
	err      error
	onDelete func()
}

func (d *testCredentialDeleter) Delete(_ context.Context, profile string) error {
	d.deleted = append(d.deleted, profile)
	if d.onDelete != nil {
		d.onDelete()
	}
	return d.err
}

func TestProfileServiceSetCreatesNormalizedProfile(t *testing.T) {
	store := config.NewStore(filepath.Join(t.TempDir(), "nama", "config.json"))
	credentials := &testCredentialDeleter{}
	profiles := app.NewProfileService(store, credentials)

	got, err := profiles.Set(t.Context(), "home", "HTTPS://HOME.EXAMPLE.COM/")
	if err != nil {
		t.Fatalf("Set() returned error: %v", err)
	}
	want := app.Profile{Name: "home", Server: "https://home.example.com"}
	if got != want {
		t.Errorf("Set() = %#v, want %#v", got, want)
	}
	if len(credentials.deleted) != 0 {
		t.Errorf("credential deletions = %#v, want none for a new profile", credentials.deleted)
	}

	persisted, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(persisted.Profiles, map[string]string{"home": "https://home.example.com"}) {
		t.Errorf("persisted profiles = %#v, want normalized home profile", persisted.Profiles)
	}
	if persisted.DefaultProfile != "" {
		t.Errorf("persisted default profile = %q, want empty", persisted.DefaultProfile)
	}
	if persisted.PreferredOutput != config.OutputHuman {
		t.Errorf("persisted output = %q, want %q", persisted.PreferredOutput, config.OutputHuman)
	}
}

func TestProfileServiceSetPreservesCredentialForSameNormalizedURL(t *testing.T) {
	store := config.NewStore(filepath.Join(t.TempDir(), "nama", "config.json"))
	initial := config.Config{
		Profiles: map[string]string{
			"home": "https://home.example.com",
		},
		PreferredOutput: config.OutputJSON,
	}
	if err := store.Save(initial); err != nil {
		t.Fatal(err)
	}
	credentials := &testCredentialDeleter{}
	profiles := app.NewProfileService(store, credentials)

	got, err := profiles.Set(t.Context(), "home", "HTTPS://HOME.EXAMPLE.COM/")
	if err != nil {
		t.Fatalf("Set() returned error: %v", err)
	}
	if want := (app.Profile{Name: "home", Server: "https://home.example.com"}); got != want {
		t.Errorf("Set() = %#v, want %#v", got, want)
	}
	if len(credentials.deleted) != 0 {
		t.Errorf("credential deletions = %#v, want none for the same normalized URL", credentials.deleted)
	}

	persisted, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(persisted, initial) {
		t.Errorf("persisted configuration = %#v, want %#v", persisted, initial)
	}
}

func TestProfileServiceSetDeletesCredentialBeforeChangedURLCommit(t *testing.T) {
	store := config.NewStore(filepath.Join(t.TempDir(), "nama", "config.json"))
	initial := config.Config{
		Profiles: map[string]string{
			"home": "https://old.example.com",
		},
		DefaultProfile:  "home",
		PreferredOutput: config.OutputJSON,
	}
	if err := store.Save(initial); err != nil {
		t.Fatal(err)
	}
	credentials := &testCredentialDeleter{}
	var serverAtDeletion string
	credentials.onDelete = func() {
		persisted, err := store.Load()
		if err != nil {
			t.Errorf("Load() during credential deletion: %v", err)
			return
		}
		serverAtDeletion = persisted.Profiles["home"]
	}
	profiles := app.NewProfileService(store, credentials)

	got, err := profiles.Set(t.Context(), "home", "https://new.example.com")
	if err != nil {
		t.Fatalf("Set() returned error: %v", err)
	}
	if want := (app.Profile{Name: "home", Server: "https://new.example.com", IsDefault: true}); got != want {
		t.Errorf("Set() = %#v, want %#v", got, want)
	}
	if !reflect.DeepEqual(credentials.deleted, []string{"home"}) {
		t.Errorf("credential deletions = %#v, want [home]", credentials.deleted)
	}
	if serverAtDeletion != "https://old.example.com" {
		t.Errorf("server persisted while credential was deleted = %q, want old URL", serverAtDeletion)
	}

	persisted, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	if persisted.Profiles["home"] != "https://new.example.com" {
		t.Errorf("persisted profile URL = %q, want new URL", persisted.Profiles["home"])
	}
	if persisted.PreferredOutput != config.OutputJSON {
		t.Errorf("persisted output = %q, want %q", persisted.PreferredOutput, config.OutputJSON)
	}
}

func TestProfileServiceSetLeavesConfigurationUntouchedWhenCredentialDeletionFails(t *testing.T) {
	store := config.NewStore(filepath.Join(t.TempDir(), "nama", "config.json"))
	initial := config.Config{
		Profiles: map[string]string{
			"home": "https://old.example.com",
		},
		DefaultProfile:  "home",
		PreferredOutput: config.OutputHuman,
	}
	if err := store.Save(initial); err != nil {
		t.Fatal(err)
	}
	deleteErr := errors.New("keyring unavailable")
	credentials := &testCredentialDeleter{err: deleteErr}
	profiles := app.NewProfileService(store, credentials)

	_, err := profiles.Set(t.Context(), "home", "https://new.example.com")
	if !errors.Is(err, deleteErr) {
		t.Fatalf("Set() error = %v, want credential deletion error", err)
	}
	if !reflect.DeepEqual(credentials.deleted, []string{"home"}) {
		t.Errorf("credential deletions = %#v, want [home]", credentials.deleted)
	}

	persisted, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(persisted, initial) {
		t.Errorf("persisted configuration = %#v, want %#v", persisted, initial)
	}
}

func TestProfileServiceUseSelectsExistingProfileAndPreservesGlobalOutput(t *testing.T) {
	store := config.NewStore(filepath.Join(t.TempDir(), "nama", "config.json"))
	initial := config.Config{
		Profiles: map[string]string{
			"home": "https://home.example.com",
			"work": "https://work.example.com",
		},
		DefaultProfile:  "home",
		PreferredOutput: config.OutputJSON,
	}
	if err := store.Save(initial); err != nil {
		t.Fatal(err)
	}
	profiles := app.NewProfileService(store, &testCredentialDeleter{})

	got, err := profiles.Use(t.Context(), "work")
	if err != nil {
		t.Fatalf("Use() returned error: %v", err)
	}
	if want := (app.Profile{Name: "work", Server: "https://work.example.com", IsDefault: true}); got != want {
		t.Errorf("Use() = %#v, want %#v", got, want)
	}

	persisted, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	if persisted.DefaultProfile != "work" {
		t.Errorf("persisted default profile = %q, want work", persisted.DefaultProfile)
	}
	if persisted.PreferredOutput != config.OutputJSON {
		t.Errorf("persisted output = %q, want %q", persisted.PreferredOutput, config.OutputJSON)
	}
}

func TestProfileServiceUseRequiresExistingProfile(t *testing.T) {
	store := config.NewStore(filepath.Join(t.TempDir(), "nama", "config.json"))
	initial := config.Config{
		Profiles: map[string]string{
			"home": "https://home.example.com",
		},
		DefaultProfile:  "home",
		PreferredOutput: config.OutputHuman,
	}
	if err := store.Save(initial); err != nil {
		t.Fatal(err)
	}
	profiles := app.NewProfileService(store, &testCredentialDeleter{})

	_, err := profiles.Use(t.Context(), "missing")
	if !errors.Is(err, config.ErrProfileNotFound) {
		t.Fatalf("Use() error = %v, want an error matching ErrProfileNotFound", err)
	}

	persisted, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(persisted, initial) {
		t.Errorf("persisted configuration = %#v, want %#v", persisted, initial)
	}
}

func TestProfileServiceListReturnsEmptyAndDeterministicProfiles(t *testing.T) {
	t.Run("empty", func(t *testing.T) {
		store := config.NewStore(filepath.Join(t.TempDir(), "nama", "config.json"))
		profiles := app.NewProfileService(store, &testCredentialDeleter{})

		got, err := profiles.List(t.Context())
		if err != nil {
			t.Fatalf("List() returned error: %v", err)
		}
		if len(got) != 0 {
			t.Errorf("List() = %#v, want empty collection", got)
		}
	})

	t.Run("sorted names identify default", func(t *testing.T) {
		store := config.NewStore(filepath.Join(t.TempDir(), "nama", "config.json"))
		if err := store.Save(config.Config{
			Profiles: map[string]string{
				"zulu":   "https://zulu.example.com",
				"alpha":  "https://alpha.example.com",
				"middle": "https://middle.example.com",
			},
			DefaultProfile: "middle",
		}); err != nil {
			t.Fatal(err)
		}
		profiles := app.NewProfileService(store, &testCredentialDeleter{})

		got, err := profiles.List(t.Context())
		if err != nil {
			t.Fatalf("List() returned error: %v", err)
		}
		want := []app.Profile{
			{Name: "alpha", Server: "https://alpha.example.com"},
			{Name: "middle", Server: "https://middle.example.com", IsDefault: true},
			{Name: "zulu", Server: "https://zulu.example.com"},
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("List() = %#v, want %#v", got, want)
		}
	})
}

func TestProfileServiceSetDoesNotOverwriteMalformedConfiguration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nama", "config.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	malformed := []byte(`{"profiles":`)
	if err := os.WriteFile(path, malformed, 0o600); err != nil {
		t.Fatal(err)
	}
	profiles := app.NewProfileService(config.NewStore(path), &testCredentialDeleter{})

	_, err := profiles.Set(t.Context(), "home", "https://home.example.com")
	if !errors.Is(err, config.ErrMalformed) {
		t.Fatalf("Set() error = %v, want an error matching ErrMalformed", err)
	}

	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, malformed) {
		t.Errorf("malformed config after Set() = %q, want original %q", got, malformed)
	}
}
