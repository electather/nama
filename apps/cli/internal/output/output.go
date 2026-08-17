// Package output renders all CLI successes and failures.
package output

import (
	"cmp"
	"encoding/json"
	"fmt"
	"io"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/electather/nama/apps/cli/internal/clierror"
)

// Mode selects the CLI output format.
type Mode string

const (
	Human Mode = "human"
	JSON  Mode = "json"
)

// Warning is public supplemental success information.
type Warning struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Renderer owns the CLI's process streams and output format.
type Renderer struct {
	mode   Mode
	stdout io.Writer
	stderr io.Writer
}

// New constructs the renderer for one command invocation.
func New(mode Mode, stdout, stderr io.Writer) *Renderer {
	return &Renderer{mode: mode, stdout: stdout, stderr: stderr}
}

// Success renders one successful result and any non-fatal warnings.
func (r *Renderer) Success(data any, warnings []Warning) error {
	if r.mode == JSON {
		return json.NewEncoder(r.stdout).Encode(struct {
			Data     any       `json:"data"`
			Warnings []Warning `json:"warnings,omitempty"`
		}{Data: data, Warnings: warnings})
	}
	for _, warning := range warnings {
		if _, err := fmt.Fprintf(r.stderr, "Warning: %s\n", humanString(warning.Message)); err != nil {
			return err
		}
	}
	return writeHuman(r.stdout, reflect.ValueOf(data), "")
}

// Failure renders only safe public error data.
func (r *Renderer) Failure(cause error) error {
	failure := clierror.Translate(cause)
	if r.mode == JSON {
		return json.NewEncoder(r.stderr).Encode(struct {
			Error *clierror.Error `json:"error"`
		}{Error: failure})
	}
	_, err := fmt.Fprintln(r.stderr, failure.Error())
	return err
}

func writeHuman(writer io.Writer, value reflect.Value, indent string) error {
	value = indirect(value)
	if !value.IsValid() {
		return nil
	}
	if value.Type() == reflect.TypeFor[time.Time]() {
		_, err := fmt.Fprintln(writer, value.Interface().(time.Time).UTC().Format(time.RFC3339))
		return err
	}

	switch value.Kind() {
	case reflect.Struct:
		for index := range value.NumField() {
			fieldType := value.Type().Field(index)
			field := value.Field(index)
			if fieldType.PkgPath != "" || !field.CanInterface() {
				continue
			}
			name, omit := jsonName(fieldType)
			if name == "" || (omit && empty(field)) {
				continue
			}
			if humanScalar(field) {
				if _, err := fmt.Fprintf(writer, "%s%s: %s\n", indent, name, scalarText(field)); err != nil {
					return err
				}
				continue
			}
			if _, err := fmt.Fprintf(writer, "%s%s:\n", indent, name); err != nil {
				return err
			}
			if err := writeHuman(writer, field, indent+"  "); err != nil {
				return err
			}
		}
		return nil
	case reflect.Slice, reflect.Array:
		for index := range value.Len() {
			item := value.Index(index)
			if humanScalar(item) {
				if _, err := fmt.Fprintf(writer, "%s- %s\n", indent, scalarText(item)); err != nil {
					return err
				}
				continue
			}
			if _, err := fmt.Fprintf(writer, "%s-\n", indent); err != nil {
				return err
			}
			if err := writeHuman(writer, item, indent+"  "); err != nil {
				return err
			}
		}
		return nil
	case reflect.Map:
		keys := value.MapKeys()
		slices.SortFunc(keys, func(left, right reflect.Value) int {
			return cmp.Compare(fmt.Sprint(left.Interface()), fmt.Sprint(right.Interface()))
		})
		for _, key := range keys {
			item := value.MapIndex(key)
			if humanScalar(item) {
				if _, err := fmt.Fprintf(writer, "%s%s: %s\n", indent, humanString(fmt.Sprint(key.Interface())), scalarText(item)); err != nil {
					return err
				}
				continue
			}
			if _, err := fmt.Fprintf(writer, "%s%s:\n", indent, humanString(fmt.Sprint(key.Interface()))); err != nil {
				return err
			}
			if err := writeHuman(writer, item, indent+"  "); err != nil {
				return err
			}
		}
		return nil
	default:
		_, err := fmt.Fprintf(writer, "%s%s\n", indent, scalarText(value))
		return err
	}
}

func indirect(value reflect.Value) reflect.Value {
	for value.IsValid() && (value.Kind() == reflect.Pointer || value.Kind() == reflect.Interface) {
		if value.IsNil() {
			return reflect.Value{}
		}
		value = value.Elem()
	}
	return value
}

func humanScalar(value reflect.Value) bool {
	value = indirect(value)
	if !value.IsValid() || value.Type() == reflect.TypeFor[time.Time]() {
		return true
	}
	switch value.Kind() {
	case reflect.Bool, reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64, reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr, reflect.Float32, reflect.Float64, reflect.String:
		return true
	default:
		return false
	}
}

func scalarText(value reflect.Value) string {
	value = indirect(value)
	if !value.IsValid() {
		return ""
	}
	if value.Type() == reflect.TypeFor[time.Time]() {
		return value.Interface().(time.Time).UTC().Format(time.RFC3339)
	}
	if value.Kind() == reflect.String {
		return humanString(value.String())
	}
	return fmt.Sprint(value.Interface())
}

func humanString(value string) string {
	quoted := strconv.Quote(value)
	return strings.ReplaceAll(strings.ReplaceAll(quoted[1:len(quoted)-1], `\"`, `"`), `\\`, `\`)
}

func jsonName(field reflect.StructField) (string, bool) {
	tag := field.Tag.Get("json")
	if tag == "-" {
		return "", false
	}
	name, options, _ := strings.Cut(tag, ",")
	if name == "" {
		name = snakeCase(field.Name)
	}
	for option := range strings.SplitSeq(options, ",") {
		if option == "omitempty" || option == "omitzero" {
			return name, true
		}
	}
	return name, false
}

func snakeCase(value string) string {
	var builder strings.Builder
	for index, character := range value {
		if index > 0 && character >= 'A' && character <= 'Z' {
			builder.WriteByte('_')
		}
		builder.WriteRune(character)
	}
	return strings.ToLower(builder.String())
}

func empty(value reflect.Value) bool {
	value = indirect(value)
	if !value.IsValid() {
		return true
	}
	return value.IsZero()
}
