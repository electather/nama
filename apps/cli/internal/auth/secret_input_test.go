package auth

import (
	"bytes"
	"errors"
	"io"
	"os"
	"testing"
)

func TestReadSetupSecretsUsesInjectedTerminalReader(t *testing.T) {
	stdin := stdinWithLine(t, "")
	reader := &fakePasswordReader{values: [][]byte{[]byte("bootstrap-token"), []byte("terminal-password")}}

	secrets, err := ReadSetupSecrets(SecretInput{
		Stdin:          stdin,
		Terminal:       true,
		Getenv:         func(string) string { return "" },
		TerminalReader: reader,
	})
	if err != nil {
		t.Fatal("reading terminal setup secrets returned an error")
	}
	if len(reader.fds) != 2 || reader.fds[0] != int(stdin.Fd()) || reader.fds[1] != int(stdin.Fd()) {
		t.Fatal("terminal setup secrets did not use the injectable no-echo reader")
	}
	requireSameSecret(t, secrets.BootstrapToken, "bootstrap-token", "terminal bootstrap token did not round-trip")
	requireSameSecret(t, secrets.Password, "terminal-password", "terminal password did not round-trip")
}

func TestReadSetupSecretsUsesEnvironmentAndOneStdinLineWhenNotTerminal(t *testing.T) {
	reader := &fakePasswordReader{values: [][]byte{[]byte("must-not-prompt")}}
	secrets, err := ReadSetupSecrets(SecretInput{
		Stdin:    stdinWithLine(t, "stdin-password\nignored"),
		Terminal: false,
		Getenv: func(name string) string {
			if name == "NAMA_BOOTSTRAP_TOKEN" {
				return "bootstrap-token"
			}
			return ""
		},
		TerminalReader: reader,
	})
	if err != nil {
		t.Fatal("reading non-terminal setup secrets returned an error")
	}
	if len(reader.fds) != 0 {
		t.Fatal("non-terminal setup secret input fell back to a prompt")
	}
	requireSameSecret(t, secrets.BootstrapToken, "bootstrap-token", "bootstrap token did not come from NAMA_BOOTSTRAP_TOKEN")
	requireSameSecret(t, secrets.Password, "stdin-password", "password was not limited to the first stdin line")
}

func TestReadSetupSecretsRequiresBootstrapTokenWithoutPromptFallback(t *testing.T) {
	reader := &fakePasswordReader{values: [][]byte{[]byte("must-not-prompt")}}

	_, err := ReadSetupSecrets(SecretInput{
		Stdin:          stdinWithLine(t, "stdin-password"),
		Terminal:       false,
		Getenv:         func(string) string { return "" },
		TerminalReader: reader,
	})
	if err == nil {
		t.Fatal("missing NAMA_BOOTSTRAP_TOKEN did not fail non-interactive setup")
	}
	if len(reader.fds) != 0 {
		t.Fatal("missing NAMA_BOOTSTRAP_TOKEN fell back to a prompt")
	}
}

func TestReadLoginPasswordUsesOneStdinLineWhenNotTerminal(t *testing.T) {
	reader := &fakePasswordReader{values: [][]byte{[]byte("must-not-prompt")}}
	password, err := ReadLoginPassword(SecretInput{
		Stdin:          stdinWithLine(t, "stdin-password\nignored"),
		Terminal:       false,
		TerminalReader: reader,
	})
	if err != nil {
		t.Fatal("reading non-terminal login password returned an error")
	}
	if len(reader.fds) != 0 {
		t.Fatal("non-terminal login password input fell back to a prompt")
	}
	requireSameSecret(t, password, "stdin-password", "login password was not limited to the first stdin line")
}

func TestInteractiveSecretPromptsAreLabeled(t *testing.T) {
	for _, test := range []struct {
		name   string
		values [][]byte
		read   func(SecretInput) error
		want   string
	}{
		{
			name:   "setup",
			values: [][]byte{[]byte("bootstrap-token"), []byte("terminal-password")},
			read: func(input SecretInput) error {
				_, err := ReadSetupSecrets(input)
				return err
			},
			want: "Bootstrap token: \nPassword: \n",
		},
		{
			name:   "login",
			values: [][]byte{[]byte("terminal-password")},
			read: func(input SecretInput) error {
				_, err := ReadLoginPassword(input)
				return err
			},
			want: "Password: \n",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			var prompt bytes.Buffer
			err := test.read(SecretInput{
				Stdin:          stdinWithLine(t, ""),
				Terminal:       true,
				Prompt:         &prompt,
				TerminalReader: &fakePasswordReader{values: test.values},
			})
			if err != nil {
				t.Fatalf("reading interactive secrets returned an error: %v", err)
			}
			if got := prompt.String(); got != test.want {
				t.Errorf("terminal prompt = %q, want %q", got, test.want)
			}
		})
	}
}

func TestSecretInputIsSilentWhenNotTerminal(t *testing.T) {
	for _, test := range []struct {
		name string
		read func(SecretInput) error
	}{
		{
			name: "setup",
			read: func(input SecretInput) error {
				_, err := ReadSetupSecrets(input)
				return err
			},
		},
		{
			name: "login",
			read: func(input SecretInput) error {
				_, err := ReadLoginPassword(input)
				return err
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			var prompt bytes.Buffer
			reader := &fakePasswordReader{values: [][]byte{[]byte("must-not-prompt")}}
			err := test.read(SecretInput{
				Stdin:          stdinWithLine(t, "password\n"),
				Getenv:         func(string) string { return "bootstrap-token" },
				Prompt:         &prompt,
				TerminalReader: reader,
			})
			if err != nil {
				t.Fatalf("reading non-terminal secrets returned an error: %v", err)
			}
			if got := prompt.String(); got != "" {
				t.Errorf("non-terminal prompt = %q, want empty", got)
			}
			if got := len(reader.fds); got != 0 {
				t.Errorf("terminal reader calls = %d, want 0", got)
			}
		})
	}
}

func TestReadSetupSecretsRejectsJSONOnTerminalBeforeReadingSecrets(t *testing.T) {
	const stdinSecret = "stdin-password\n"
	stdin := stdinWithLine(t, stdinSecret)
	var prompt bytes.Buffer
	reader := &fakePasswordReader{values: [][]byte{[]byte("terminal-secret")}}

	_, err := ReadSetupSecrets(SecretInput{
		Stdin:          stdin,
		Terminal:       true,
		JSON:           true,
		Prompt:         &prompt,
		Getenv:         func(string) string { return "bootstrap-token" },
		TerminalReader: reader,
	})

	if err == nil {
		t.Fatal("terminal JSON setup input did not fail before reading secrets")
	}
	if got := len(reader.fds); got != 0 {
		t.Errorf("terminal reader calls = %d, want 0", got)
	}
	requireUnreadSecretInput(t, stdin, stdinSecret)
	if got := prompt.String(); got != "" {
		t.Errorf("terminal JSON setup prompt = %q, want empty", got)
	}
}

func TestReadLoginPasswordRejectsJSONOnTerminalBeforeReadingSecrets(t *testing.T) {
	const stdinSecret = "stdin-password\n"
	stdin := stdinWithLine(t, stdinSecret)
	var prompt bytes.Buffer
	reader := &fakePasswordReader{values: [][]byte{[]byte("terminal-secret")}}

	_, err := ReadLoginPassword(SecretInput{
		Stdin:          stdin,
		Terminal:       true,
		JSON:           true,
		Prompt:         &prompt,
		TerminalReader: reader,
	})

	if err == nil {
		t.Fatal("terminal JSON login input did not fail before reading secrets")
	}
	if got := len(reader.fds); got != 0 {
		t.Errorf("terminal reader calls = %d, want 0", got)
	}
	requireUnreadSecretInput(t, stdin, stdinSecret)
	if got := prompt.String(); got != "" {
		t.Errorf("terminal JSON login prompt = %q, want empty", got)
	}
}

func TestReadTerminalSecretClearsBytesWhenTrailingNewlineFails(t *testing.T) {
	writeErr := errors.New("write trailing newline")
	secret := []byte("terminal-secret")

	_, err := ReadLoginPassword(SecretInput{
		Stdin:          stdinWithLine(t, ""),
		Terminal:       true,
		Prompt:         &failSecondWrite{err: writeErr},
		TerminalReader: &fakePasswordReader{values: [][]byte{secret}},
	})

	if !errors.Is(err, writeErr) {
		t.Fatalf("ReadLoginPassword() error = %v, want trailing newline write error", err)
	}
	requireClearedSecret(t, secret)
}

func TestReadTerminalSecretClearsPartialBytesOnReadError(t *testing.T) {
	readErr := errors.New("read password")
	secret := []byte("partial-secret")

	_, err := ReadLoginPassword(SecretInput{
		Stdin:          stdinWithLine(t, ""),
		Terminal:       true,
		Prompt:         io.Discard,
		TerminalReader: &fakePasswordReader{values: [][]byte{secret}, errs: []error{readErr}},
	})

	if !errors.Is(err, readErr) {
		t.Fatalf("ReadLoginPassword() error = %v, want password read error", err)
	}
	requireClearedSecret(t, secret)
}

func TestReadNonInteractivePasswordStripsOnlyLineEnding(t *testing.T) {
	for _, test := range []struct {
		name string
		read func(SecretInput) (string, error)
	}{
		{
			name: "setup",
			read: func(input SecretInput) (string, error) {
				secrets, err := ReadSetupSecrets(input)
				return secrets.Password, err
			},
		},
		{
			name: "login",
			read: ReadLoginPassword,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			for _, lineEnding := range []struct {
				name  string
				value string
			}{
				{name: "LF", value: "\n"},
				{name: "CRLF", value: "\r\n"},
			} {
				t.Run(lineEnding.name, func(t *testing.T) {
					const want = "  password with spaces \t"
					password, err := test.read(SecretInput{
						Stdin:    stdinWithLine(t, want+lineEnding.value+"trailing-input"),
						Getenv:   func(string) string { return "bootstrap-token" },
						Terminal: false,
					})
					if err != nil {
						t.Fatalf("reading password returned an error: %v", err)
					}
					requireSameSecret(t, password, want, "password whitespace or line ending was not preserved correctly")
				})
			}
		})
	}
}

func requireClearedSecret(t *testing.T, secret []byte) {
	t.Helper()
	for index, value := range secret {
		if value != 0 {
			t.Fatalf("secret byte %d = %d, want cleared", index, value)
		}
	}
}

func requireUnreadSecretInput(t *testing.T, stdin *os.File, want string) {
	t.Helper()
	got, err := io.ReadAll(stdin)
	if err != nil {
		t.Fatalf("reading remaining stdin: %v", err)
	}
	if string(got) != want {
		t.Errorf("remaining stdin = %q, want %q", got, want)
	}
}

type fakePasswordReader struct {
	values [][]byte
	errs   []error
	fds    []int
}

func (r *fakePasswordReader) ReadPassword(fd int) ([]byte, error) {
	r.fds = append(r.fds, fd)
	index := len(r.fds) - 1
	var err error
	if index < len(r.errs) {
		err = r.errs[index]
	}
	return r.values[index], err
}

type failSecondWrite struct {
	calls int
	err   error
}

func (w *failSecondWrite) Write(bytes []byte) (int, error) {
	w.calls++
	if w.calls == 2 {
		return 0, w.err
	}
	return len(bytes), nil
}

func stdinWithLine(t *testing.T, line string) *os.File {
	t.Helper()
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal("creating stdin pipe failed")
	}
	if _, err := writer.WriteString(line); err != nil {
		reader.Close()
		writer.Close()
		t.Fatal("writing stdin pipe failed")
	}
	if err := writer.Close(); err != nil {
		reader.Close()
		t.Fatal("closing stdin pipe writer failed")
	}
	t.Cleanup(func() { reader.Close() })
	return reader
}
