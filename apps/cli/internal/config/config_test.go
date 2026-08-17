package config_test

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"github.com/electather/nama/apps/cli/internal/config"
)

func TestValidateProfileName(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		profile string
		valid   bool
	}{
		{name: "single letter", profile: "a", valid: true},
		{name: "letter digit punctuation", profile: "home-2.alpha_test", valid: true},
		{name: "digit first", profile: "2nd", valid: true},
		{name: "maximum length", profile: "a" + strings.Repeat("b", 63), valid: true},
		{name: "empty", profile: ""},
		{name: "too long", profile: "a" + strings.Repeat("b", 64)},
		{name: "uppercase", profile: "Home"},
		{name: "leading hyphen", profile: "-home"},
		{name: "leading underscore", profile: "_home"},
		{name: "leading period", profile: ".home"},
		{name: "slash", profile: "home/office"},
		{name: "space", profile: "home office"},
		{name: "non ASCII", profile: "høme"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := config.ValidateProfileName(tc.profile)
			if tc.valid && err != nil {
				t.Fatalf("ValidateProfileName(%q) returned %v, want nil", tc.profile, err)
			}
			if !tc.valid && err == nil {
				t.Fatalf("ValidateProfileName(%q) returned nil, want error", tc.profile)
			}
		})
	}
}

func TestNormalizeServerURL(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name         string
		input        string
		wantURL      string
		wantInsecure bool
		wantErr      bool
	}{
		{name: "HTTPS public target normalizes scheme host and root slash", input: "HTTPS://EXAMPLE.COM/", wantURL: "https://example.com"},
		{name: "HTTPS private target is accepted", input: "https://192.168.1.20/", wantURL: "https://192.168.1.20"},
		{name: "HTTPS reverse proxy path is preserved", input: "HTTPS://Example.COM/nama/api/", wantURL: "https://example.com/nama/api/"},
		{name: "HTTPS minimum valid port is preserved", input: "HTTPS://EXAMPLE.COM:1/", wantURL: "https://example.com:1"},
		{name: "HTTPS maximum valid port is preserved", input: "HTTPS://EXAMPLE.COM:65535/", wantURL: "https://example.com:65535"},
		{name: "HTTP IPv4 loopback", input: "HTTP://127.0.0.1:8080/", wantURL: "http://127.0.0.1:8080", wantInsecure: true},
		{name: "HTTP IPv6 loopback", input: "http://[::1]/", wantURL: "http://[::1]", wantInsecure: true},
		{name: "HTTP IPv4 private ten range", input: "http://10.42.0.1/", wantURL: "http://10.42.0.1", wantInsecure: true},
		{name: "HTTP IPv4 private 172 range", input: "http://172.16.0.1/", wantURL: "http://172.16.0.1", wantInsecure: true},
		{name: "HTTP IPv4 private 192 range", input: "http://192.168.1.1/", wantURL: "http://192.168.1.1", wantInsecure: true},
		{name: "HTTP IPv4 link local", input: "http://169.254.10.11/", wantURL: "http://169.254.10.11", wantInsecure: true},
		{name: "HTTP IPv6 private unique local", input: "http://[fd12:3456::1]/", wantURL: "http://[fd12:3456::1]", wantInsecure: true},
		{name: "HTTP IPv6 link local", input: "http://[fe80::1]/", wantURL: "http://[fe80::1]", wantInsecure: true},
		{name: "HTTP IPv6 link local preserves zone case", input: "HTTP://[FE80::1%25LAN0]:8080/", wantURL: "http://[fe80::1%25LAN0]:8080", wantInsecure: true},
		{name: "HTTP localhost", input: "http://LOCALHOST:8080/", wantURL: "http://localhost:8080", wantInsecure: true},
		{name: "HTTP localhost subdomain", input: "http://api.localhost/", wantURL: "http://api.localhost", wantInsecure: true},
		{name: "HTTP local reverse proxy path", input: "HTTP://NAMA.LOCAL/reverse-proxy/", wantURL: "http://nama.local/reverse-proxy/", wantInsecure: true},
		{name: "public HTTP hostname", input: "http://example.com", wantErr: true},
		{name: "public HTTP IPv4", input: "http://8.8.8.8", wantErr: true},
		{name: "public HTTP IPv6", input: "http://[2001:4860:4860::8888]", wantErr: true},
		{name: "hostname that only resembles localhost", input: "http://localhost.example", wantErr: true},
		{name: "localhost suffix boundary", input: "http://api.localhost.example", wantErr: true},
		{name: "local suffix boundary", input: "http://nama.local.example", wantErr: true},
		{name: "hostname resolving to loopback is not trusted", input: "http://127.0.0.1.nip.io", wantErr: true},
		{name: "relative URL", input: "/nama", wantErr: true},
		{name: "unsupported scheme", input: "ftp://example.com", wantErr: true},
		{name: "user information", input: "https://operator:secret@example.com", wantErr: true},
		{name: "query", input: "https://example.com?trace=true", wantErr: true},
		{name: "fragment", input: "https://example.com#section", wantErr: true},
		{name: "empty hostname with explicit port", input: "https://:443", wantErr: true},
		{name: "empty explicit port", input: "https://example.com:", wantErr: true},
		{name: "non-numeric explicit port", input: "https://example.com:not-a-port", wantErr: true},
		{name: "port zero is out of range", input: "https://example.com:0", wantErr: true},
		{name: "port above valid range", input: "https://example.com:65536", wantErr: true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			gotURL, gotInsecure, err := config.NormalizeServerURL(tc.input)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("NormalizeServerURL(%q) returned (%q, %t, nil), want error", tc.input, gotURL, gotInsecure)
				}
				return
			}
			if err != nil {
				t.Fatalf("NormalizeServerURL(%q) returned error: %v", tc.input, err)
			}
			if gotURL != tc.wantURL {
				t.Errorf("NormalizeServerURL(%q) URL = %q, want %q", tc.input, gotURL, tc.wantURL)
			}
			if gotInsecure != tc.wantInsecure {
				t.Errorf("NormalizeServerURL(%q) insecure warning = %t, want %t", tc.input, gotInsecure, tc.wantInsecure)
			}
		})
	}
}

func TestStoreLoadMissingFileReturnsDefaultConfiguration(t *testing.T) {
	t.Parallel()

	store := config.NewStore(filepath.Join(t.TempDir(), "nama", "config.json"))

	got, err := store.Load()
	if err != nil {
		t.Fatalf("Load() returned error: %v", err)
	}
	if len(got.Profiles) != 0 {
		t.Errorf("Load() profiles = %#v, want empty", got.Profiles)
	}
	if got.DefaultProfile != "" {
		t.Errorf("Load() default profile = %q, want empty", got.DefaultProfile)
	}
	if got.PreferredOutput != config.OutputHuman {
		t.Errorf("Load() preferred output = %q, want %q", got.PreferredOutput, config.OutputHuman)
	}
}

func TestStoreLoadRejectsMalformedConfiguration(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "nama", "config.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"profiles":`), 0o600); err != nil {
		t.Fatal(err)
	}

	_, err := config.NewStore(path).Load()
	if !errors.Is(err, config.ErrMalformed) {
		t.Fatalf("Load() error = %v, want an error matching ErrMalformed", err)
	}
}

func TestStoreSavesLoadsAndReplacesConfiguration(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "nama", "config.json")
	store := config.NewStore(path)
	before := config.Config{
		Profiles: map[string]string{
			"home": "https://old.example.com",
		},
		DefaultProfile:  "home",
		PreferredOutput: config.OutputJSON,
	}
	after := config.Config{
		Profiles: map[string]string{
			"home": "https://new.example.com",
		},
		DefaultProfile:  "home",
		PreferredOutput: config.OutputHuman,
	}

	if err := store.Save(before); err != nil {
		t.Fatalf("initial Save() returned error: %v", err)
	}
	got, err := store.Load()
	if err != nil {
		t.Fatalf("Load() after initial Save() returned error: %v", err)
	}
	if !reflect.DeepEqual(got, before) {
		t.Errorf("Load() after initial Save() = %#v, want %#v", got, before)
	}

	if err := store.Save(after); err != nil {
		t.Fatalf("replacement Save() returned error: %v", err)
	}
	got, err = store.Load()
	if err != nil {
		t.Fatalf("Load() after replacement Save() returned error: %v", err)
	}
	if !reflect.DeepEqual(got, after) {
		t.Errorf("Load() after replacement Save() = %#v, want %#v", got, after)
	}
}

func TestStorePersistsOwnerOnlyAndLeavesExistingConfigOnAtomicWriteFailure(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows does not enforce Unix file permissions")
	}

	path := filepath.Join(t.TempDir(), "nama", "config.json")
	store := config.NewStore(path)
	before := config.Config{
		Profiles: map[string]string{
			"home": "https://old.example.com",
		},
		DefaultProfile:  "home",
		PreferredOutput: config.OutputJSON,
	}
	if err := store.Save(before); err != nil {
		t.Fatalf("initial Save() returned error: %v", err)
	}

	directoryInfo, err := os.Stat(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	if got := directoryInfo.Mode().Perm(); got != 0o700 {
		t.Errorf("config directory mode = %#o, want 0700", got)
	}
	fileInfo, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := fileInfo.Mode().Perm(); got != 0o600 {
		t.Errorf("config file mode = %#o, want 0600", got)
	}

	if err := os.Chmod(filepath.Dir(path), 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Chmod(filepath.Dir(path), 0o700); err != nil {
			t.Errorf("restore config directory permissions: %v", err)
		}
	})

	after := config.Config{
		Profiles: map[string]string{
			"home": "https://new.example.com",
		},
		DefaultProfile:  "home",
		PreferredOutput: config.OutputHuman,
	}
	if err := store.Save(after); err == nil {
		t.Fatal("Save() returned nil after its directory stopped allowing temporary-file creation, want error")
	}

	got, err := store.Load()
	if err != nil {
		t.Fatalf("Load() after failed Save() returned error: %v", err)
	}
	if !reflect.DeepEqual(got, before) {
		t.Errorf("Load() after failed Save() = %#v, want %#v", got, before)
	}
}

func TestResolveUsesFlagEnvironmentConfiguredAndBuiltinPrecedence(t *testing.T) {
	t.Parallel()

	configured := config.Config{
		Profiles: map[string]string{
			"default":     "https://default.example.com",
			"environment": "https://environment-profile.example.com",
			"flag":        "https://flag-profile.example.com",
		},
		DefaultProfile:  "default",
		PreferredOutput: config.OutputJSON,
	}

	tests := []struct {
		name   string
		config config.Config
		input  config.ResolutionInput
		want   config.Resolved
	}{
		{
			name:   "flags win",
			config: configured,
			input: config.ResolutionInput{
				ProfileFlag: "flag",
				ProfileEnv:  "environment",
				ServerFlag:  "HTTPS://FLAG-OVERRIDE.EXAMPLE.COM/",
				ServerEnv:   "https://environment-override.example.com",
				OutputFlag:  "human",
				OutputEnv:   "json",
			},
			want: config.Resolved{
				Profile: "flag",
				Server:  "https://flag-override.example.com",
				Output:  config.OutputHuman,
			},
		},
		{
			name:   "environment wins configured values",
			config: configured,
			input: config.ResolutionInput{
				ProfileEnv: "environment",
				ServerEnv:  "HTTPS://ENVIRONMENT-OVERRIDE.EXAMPLE.COM/",
				OutputEnv:  "human",
			},
			want: config.Resolved{
				Profile: "environment",
				Server:  "https://environment-override.example.com",
				Output:  config.OutputHuman,
			},
		},
		{
			name:   "configured default profile server and output apply",
			config: configured,
			want: config.Resolved{
				Profile: "default",
				Server:  "https://default.example.com",
				Output:  config.OutputJSON,
			},
		},
		{
			name: "built in human output applies without a configured preference",
			config: config.Config{
				Profiles: map[string]string{
					"default": "https://default.example.com",
				},
				DefaultProfile: "default",
			},
			want: config.Resolved{
				Profile: "default",
				Server:  "https://default.example.com",
				Output:  config.OutputHuman,
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := config.Resolve(tc.config, tc.input)
			if err != nil {
				t.Fatalf("Resolve() returned error: %v", err)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("Resolve() = %#v, want %#v", got, tc.want)
			}
		})
	}
}
