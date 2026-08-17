// Package config owns the non-secret CLI configuration file and its input resolution.
package config

import (
	"bytes"
	"cmp"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

var (
	// ErrMalformed marks a configuration file that cannot be safely used.
	ErrMalformed = errors.New("malformed configuration")
	// ErrProfileNotFound marks a requested profile that is not configured.
	ErrProfileNotFound = errors.New("profile not found")
	// ErrUnsafeTransport marks a plain-HTTP target outside the permitted local networks.
	ErrUnsafeTransport = errors.New("plain HTTP requires a local target")
)

// OutputMode is the CLI's configured output preference.
type OutputMode string

const (
	OutputHuman OutputMode = "human"
	OutputJSON  OutputMode = "json"
)

// Config is the complete non-secret configuration persisted by the CLI.
type Config struct {
	Profiles        map[string]string `json:"profiles"`
	DefaultProfile  string            `json:"default_profile"`
	PreferredOutput OutputMode        `json:"preferred_output"`
}

// Store persists configuration at one explicit location.
type Store struct {
	path string
}

// NewStore constructs a Store for path.
func NewStore(path string) *Store {
	return &Store{path: path}
}

// Load returns the saved configuration, or the initial configuration when no file exists.
func (s *Store) Load() (Config, error) {
	contents, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return defaultConfig(), nil
	}
	if err != nil {
		return Config{}, fmt.Errorf("read configuration: %w", err)
	}

	trimmed := bytes.TrimSpace(contents)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return Config{}, malformed(errors.New("configuration must be a JSON object"))
	}

	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	decoder.DisallowUnknownFields()
	var value Config
	if err := decoder.Decode(&value); err != nil {
		return Config{}, malformed(err)
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return Config{}, malformed(errors.New("configuration contains multiple JSON values"))
		}
		return Config{}, malformed(err)
	}

	value, err = canonicalConfig(value)
	if err != nil {
		return Config{}, malformed(err)
	}
	return value, nil
}

// Save atomically replaces the configuration with an owner-readable, owner-writable file.
func (s *Store) Save(value Config) error {
	value, err := canonicalConfig(value)
	if err != nil {
		return fmt.Errorf("save configuration: %w", err)
	}

	directory := filepath.Dir(s.path)
	if err := ensureOwnerOnlyDirectory(directory); err != nil {
		return fmt.Errorf("create configuration directory: %w", err)
	}

	file, err := os.CreateTemp(directory, ".config-")
	if err != nil {
		return fmt.Errorf("create temporary configuration: %w", err)
	}
	temporaryPath := file.Name()
	keepTemporary := true
	defer func() {
		if keepTemporary {
			_ = file.Close()
			_ = os.Remove(temporaryPath)
		}
	}()

	if err := file.Chmod(0o600); err != nil {
		return fmt.Errorf("secure temporary configuration: %w", err)
	}
	encoder := json.NewEncoder(file)
	if err := encoder.Encode(value); err != nil {
		return fmt.Errorf("encode configuration: %w", err)
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("sync temporary configuration: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close temporary configuration: %w", err)
	}
	if err := replaceFile(temporaryPath, s.path); err != nil {
		return fmt.Errorf("replace configuration: %w", err)
	}
	keepTemporary = false
	return nil
}

// ResolutionInput supplies already-read global flag and environment values.
type ResolutionInput struct {
	ProfileFlag string
	ProfileEnv  string
	ServerFlag  string
	ServerEnv   string
	OutputFlag  string
	OutputEnv   string
}

// Resolved contains the effective global values.
type Resolved struct {
	Profile           string
	Server            string
	Output            OutputMode
	InsecureTransport bool
}

// Resolve applies flag, environment, configuration, and built-in precedence.
func Resolve(value Config, input ResolutionInput) (Resolved, error) {
	value, err := canonicalConfig(value)
	if err != nil {
		return Resolved{}, err
	}

	profile := firstNonEmpty(input.ProfileFlag, input.ProfileEnv, value.DefaultProfile)
	var profileServer string
	if profile != "" {
		if err := ValidateProfileName(profile); err != nil {
			return Resolved{}, err
		}
		var exists bool
		profileServer, exists = value.Profiles[profile]
		if !exists {
			return Resolved{}, ErrProfileNotFound
		}
	}

	server := firstNonEmpty(input.ServerFlag, input.ServerEnv, profileServer)
	resolved := Resolved{Profile: profile, Output: outputPreference(value, input)}
	if err := validateOutput(resolved.Output); err != nil {
		return Resolved{}, err
	}
	if server == "" {
		return resolved, nil
	}

	resolved.Server, resolved.InsecureTransport, err = NormalizeServerURL(server)
	if err != nil {
		return Resolved{}, err
	}
	return resolved, nil
}

// ValidateProfileName validates the stable profile-name format.
func ValidateProfileName(name string) error {
	if len(name) == 0 || len(name) > 64 || !isLowerLetterOrDigit(name[0]) {
		return errors.New("invalid profile name")
	}
	for i := 1; i < len(name); i++ {
		character := name[i]
		if !isLowerLetterOrDigit(character) && character != '.' && character != '_' && character != '-' {
			return errors.New("invalid profile name")
		}
	}
	return nil
}

// NormalizeServerURL validates a server target and returns its canonical form.
func NormalizeServerURL(raw string) (string, bool, error) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return "", false, errors.New("invalid server URL")
	}
	hostname := parsed.Hostname()
	if !parsed.IsAbs() || parsed.Host == "" || hostname == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" || strings.Contains(raw, "#") {
		return "", false, errors.New("invalid server URL")
	}

	port := parsed.Port()
	if strings.HasSuffix(parsed.Host, ":") {
		return "", false, errors.New("invalid server URL")
	}
	if port != "" {
		number, err := strconv.ParseUint(port, 10, 16)
		if err != nil || number == 0 {
			return "", false, errors.New("invalid server URL")
		}
	}

	parsed.Scheme = strings.ToLower(parsed.Scheme)
	host, zone, hasZone := strings.Cut(hostname, "%")
	host = strings.ToLower(host)
	if hasZone {
		host += "%" + zone
	}
	if port != "" {
		parsed.Host = net.JoinHostPort(host, port)
	} else if strings.Contains(host, ":") {
		parsed.Host = "[" + host + "]"
	} else {
		parsed.Host = host
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", false, errors.New("unsupported server URL scheme")
	}
	if parsed.Path == "/" && parsed.RawPath == "" {
		parsed.Path = ""
	}

	insecure := parsed.Scheme == "http"
	if insecure && !allowsHTTP(parsed.Hostname()) {
		return "", false, ErrUnsafeTransport
	}
	return parsed.String(), insecure, nil
}

func defaultConfig() Config {
	return Config{
		Profiles:        map[string]string{},
		PreferredOutput: OutputHuman,
	}
}

func canonicalConfig(value Config) (Config, error) {
	canonical := defaultConfig()
	canonical.DefaultProfile = value.DefaultProfile
	canonical.PreferredOutput = value.PreferredOutput
	if canonical.PreferredOutput == "" {
		canonical.PreferredOutput = OutputHuman
	}
	if err := validateOutput(canonical.PreferredOutput); err != nil {
		return Config{}, err
	}

	for name, server := range value.Profiles {
		if err := ValidateProfileName(name); err != nil {
			return Config{}, err
		}
		normalized, _, err := NormalizeServerURL(server)
		if err != nil {
			return Config{}, err
		}
		canonical.Profiles[name] = normalized
	}
	if canonical.DefaultProfile != "" {
		if err := ValidateProfileName(canonical.DefaultProfile); err != nil {
			return Config{}, err
		}
		if _, exists := canonical.Profiles[canonical.DefaultProfile]; !exists {
			return Config{}, errors.New("default profile is not configured")
		}
	}
	return canonical, nil
}

func ensureOwnerOnlyDirectory(path string) error {
	if err := os.MkdirAll(path, 0o700); err != nil {
		return err
	}
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return errors.New("configuration path parent is not a directory")
	}
	if permissions := info.Mode().Perm(); permissions&0o077 != 0 {
		return os.Chmod(path, permissions&^0o077)
	}
	return nil
}

func outputPreference(value Config, input ResolutionInput) OutputMode {
	if input.OutputFlag != "" {
		return OutputMode(input.OutputFlag)
	}
	if input.OutputEnv != "" {
		return OutputMode(input.OutputEnv)
	}
	return value.PreferredOutput
}

func validateOutput(output OutputMode) error {
	if output != OutputHuman && output != OutputJSON {
		return errors.New("invalid output mode")
	}
	return nil
}

func firstNonEmpty(values ...string) string {
	return cmp.Or(values...)
}

func isLowerLetterOrDigit(character byte) bool {
	return character >= 'a' && character <= 'z' || character >= '0' && character <= '9'
}

func allowsHTTP(host string) bool {
	ipHost, _, _ := strings.Cut(host, "%")
	if ip := net.ParseIP(ipHost); ip != nil {
		return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast()
	}
	return host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local")
}

func malformed(cause error) error {
	return fmt.Errorf("%w: %v", ErrMalformed, cause)
}
