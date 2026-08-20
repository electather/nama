package auth

import (
	"bufio"
	"errors"
	"io"
	"os"
	"strings"

	"golang.org/x/term"
)

// ErrBootstrapTokenRequired reports a missing non-interactive setup bootstrap token.
var ErrBootstrapTokenRequired = errors.New("NAMA_BOOTSTRAP_TOKEN is required for non-interactive setup")

// ErrTerminalJSON reports an unsafe JSON-mode attempt to read an echoing terminal.
var ErrTerminalJSON = errors.New("JSON output cannot read secrets from a terminal")

// PasswordReader reads one secret without terminal echo.
type PasswordReader interface {
	ReadPassword(fd int) ([]byte, error)
}

// SecretInput supplies the process inputs used to read setup and login secrets.
type SecretInput struct {
	Stdin          *os.File
	Terminal       bool
	JSON           bool
	Prompt         io.Writer
	Getenv         func(string) string
	TerminalReader PasswordReader
}

// SetupSecrets are the bootstrap credential and initial administrator password.
type SetupSecrets struct {
	BootstrapToken string
	Password       string
}

type terminalPasswordReader struct{}

func (terminalPasswordReader) ReadPassword(fd int) ([]byte, error) {
	return term.ReadPassword(fd)
}

// ReadSetupSecrets reads terminal secrets interactively, or the bootstrap
// environment variable and one password line when interaction is unavailable.
func ReadSetupSecrets(input SecretInput) (SetupSecrets, error) {
	if input.Terminal && input.JSON {
		return SetupSecrets{}, ErrTerminalJSON
	}

	if input.Terminal && !input.JSON {
		bootstrapToken, err := ReadTerminalSecret(input, "Bootstrap token: ")
		if err != nil {
			return SetupSecrets{}, err
		}
		password, err := ReadTerminalSecret(input, "Password: ")
		if err != nil {
			return SetupSecrets{}, err
		}
		return SetupSecrets{BootstrapToken: bootstrapToken, Password: password}, nil
	}

	bootstrapToken := input.getenv("NAMA_BOOTSTRAP_TOKEN")
	if bootstrapToken == "" {
		return SetupSecrets{}, ErrBootstrapTokenRequired
	}
	password, err := readStdinLine(input.stdin())
	if err != nil {
		return SetupSecrets{}, err
	}
	return SetupSecrets{BootstrapToken: bootstrapToken, Password: password}, nil
}

// ReadLoginPassword reads a terminal password interactively or one stdin line.
func ReadLoginPassword(input SecretInput) (string, error) {
	if input.Terminal && input.JSON {
		return "", ErrTerminalJSON
	}

	if input.Terminal && !input.JSON {
		return ReadTerminalSecret(input, "Password: ")
	}
	return readStdinLine(input.stdin())
}

func (input SecretInput) getenv(name string) string {
	if input.Getenv != nil {
		return input.Getenv(name)
	}
	return os.Getenv(name)
}

func (input SecretInput) stdin() *os.File {
	if input.Stdin != nil {
		return input.Stdin
	}
	return os.Stdin
}

func (input SecretInput) prompt() io.Writer {
	if input.Prompt != nil {
		return input.Prompt
	}
	return os.Stderr
}

// ReadTerminalSecret reads one labelled secret from terminal stdin without echo.
func ReadTerminalSecret(input SecretInput, prompt string) (string, error) {
	reader := input.TerminalReader
	if reader == nil {
		reader = terminalPasswordReader{}
	}
	if _, err := io.WriteString(input.prompt(), prompt); err != nil {
		return "", err
	}

	secret, readErr := reader.ReadPassword(int(input.stdin().Fd()))
	defer clear(secret)
	_, promptErr := io.WriteString(input.prompt(), "\n")
	if readErr != nil {
		return "", readErr
	}
	if promptErr != nil {
		return "", promptErr
	}
	return string(secret), nil
}

func readStdinLine(stdin *os.File) (string, error) {
	line, err := bufio.NewReader(stdin).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return "", err
	}
	if withoutNewline, ok := strings.CutSuffix(line, "\n"); ok {
		line, _ = strings.CutSuffix(withoutNewline, "\r")
	}
	return line, nil
}
