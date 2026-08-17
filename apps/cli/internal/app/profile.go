// Package app contains concrete CLI application operations.
package app

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"slices"

	"github.com/electather/nama/apps/cli/internal/config"
)

// CredentialDeleter is the profile operation's boundary for removing a stale credential.
type CredentialDeleter interface {
	Delete(context.Context, string) error
}

// Profile is a configured server target.
type Profile struct {
	Name      string `json:"name"`
	Server    string `json:"server"`
	IsDefault bool   `json:"default"`
}

// ProfileService manages named server profiles.
type ProfileService struct {
	store       *config.Store
	credentials CredentialDeleter
}

// NewProfileService constructs a profile operation with its concrete dependencies.
func NewProfileService(store *config.Store, credentials CredentialDeleter) *ProfileService {
	return &ProfileService{store: store, credentials: credentials}
}

// Set creates or updates a profile after removing a credential tied to a changed target.
func (s *ProfileService) Set(ctx context.Context, name, server string) (Profile, error) {
	if err := config.ValidateProfileName(name); err != nil {
		return Profile{}, err
	}
	normalizedServer, _, err := config.NormalizeServerURL(server)
	if err != nil {
		return Profile{}, err
	}

	value, err := s.store.Load()
	if err != nil {
		return Profile{}, err
	}
	previousServer, exists := value.Profiles[name]
	if exists && previousServer == normalizedServer {
		return profileFromConfig(value, name), nil
	}
	if exists {
		if s.credentials == nil {
			return Profile{}, errors.New("credential deletion is unavailable")
		}
		if err := s.credentials.Delete(ctx, name); err != nil {
			return Profile{}, fmt.Errorf("delete credential for profile: %w", err)
		}
	}

	value.Profiles[name] = normalizedServer
	if err := s.store.Save(value); err != nil {
		return Profile{}, err
	}
	return profileFromConfig(value, name), nil
}

// Use selects an existing profile as the default.
func (s *ProfileService) Use(_ context.Context, name string) (Profile, error) {
	if err := config.ValidateProfileName(name); err != nil {
		return Profile{}, err
	}

	value, err := s.store.Load()
	if err != nil {
		return Profile{}, err
	}
	if _, exists := value.Profiles[name]; !exists {
		return Profile{}, config.ErrProfileNotFound
	}
	if value.DefaultProfile != name {
		value.DefaultProfile = name
		if err := s.store.Save(value); err != nil {
			return Profile{}, err
		}
	}
	return profileFromConfig(value, name), nil
}

// List returns every configured profile in name order.
func (s *ProfileService) List(_ context.Context) ([]Profile, error) {
	value, err := s.store.Load()
	if err != nil {
		return nil, err
	}

	names := slices.Sorted(maps.Keys(value.Profiles))

	profiles := make([]Profile, 0, len(names))
	for _, name := range names {
		profiles = append(profiles, profileFromConfig(value, name))
	}
	return profiles, nil
}

func profileFromConfig(value config.Config, name string) Profile {
	return Profile{
		Name:      name,
		Server:    value.Profiles[name],
		IsDefault: value.DefaultProfile == name,
	}
}
