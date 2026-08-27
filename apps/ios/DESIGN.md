---
name: Nama for Apple
description: Native connection, authorization, Home, and canonical media Details for a self-hosted Nama endpoint.
typography:
  large-title:
    fontFamily: "SF Pro / SF Compact system text"
    fontSize: "largeTitle"
    fontWeight: "regular"
    lineHeight: "system"
  headline:
    fontFamily: "SF Pro / SF Compact system text"
    fontSize: "headline"
    fontWeight: "semibold"
    lineHeight: "system"
  body:
    fontFamily: "SF Pro / SF Compact system text"
    fontSize: "body"
    fontWeight: "regular"
    lineHeight: "system"
  endpoint:
    fontFamily: "SF Mono / system monospaced"
    fontSize: "body or footnote"
    fontWeight: "regular"
    lineHeight: "system"
spacing:
  connection-content-max-width: "640pt"
  mac-window-min-width: "520pt"
  mac-window-min-height: "420pt"
  tv-content-max-width: "900pt"
  tv-content-padding: "64pt"
  tv-section-gap: "28pt"
  tv-action-gap: "20pt"
---

# Design System: Nama for Apple

## Overview

**Creative North Star: "The Connection Ledger"**

Nama’s Apple surface is a calm, native record of one endpoint, its current
authorization, and the canonical media it exposes. Each screen answers the
practical question in front of the person: what is selected, what is true about
it now, and which safe action can move forward. The visual system earns trust
through system controls, exact identity, and explicit terminal states—not visual
ceremony.

The system is deliberately restrained. iPhone, iPad, and Mac use a
`NavigationStack` with grouped forms; Apple TV uses a focus-aware scrolling
column with the same state and action vocabulary. The current design has no
custom brand palette, font, radius, or shadow scale. System appearance,
Dynamic Type, contrast settings, and platform focus behavior are the visual
system’s foundation.

**Key Characteristics:**

- Native forms and standard controls over bespoke setup chrome.
- One visible endpoint, rendered as evidence rather than decoration.
- State-led hierarchy: request, confirmation, verification, ready,
  setup-required, failure, and HTTPS-required states each have a specific next
  action.
- Tight, task-first content widths: a 640pt maximum for the shared form and a
  900pt maximum with 64pt padding for Apple TV.
- System motion only: navigation, controls, and `ProgressView` communicate
  progress without choreographed entrance or loading sequences.

## Colors

Nama uses adaptive SwiftUI semantic colors, not a fixed sRGB palette. The
frontmatter intentionally carries no color tokens: hard-coded hex values would
misrepresent an app that must follow Light Mode, Dark Mode, Increased Contrast,
and platform tint settings.

### Primary

- **System tint:** The platform-selected action color drives
  `.borderedProminent` actions such as **Connect**, **Continue**, and
  **Retry**. It signals the one affirmative action for the present state.

### Neutral

- **Primary label:** Default system foreground for headings, instructions, and
  editable endpoint text.
- **Secondary label:** Muted system foreground for explanatory and endpoint
  context where it remains secondary to the current task.
- **Grouped form surfaces:** Platform-managed grouped-form and navigation
  materials provide structure without custom panels or card stacks.

### State Colors

- **Warning orange:** Reserved for the explicit unencrypted-local-HTTP warning;
  it appears with an SF Symbol, explanatory text, and a combined accessibility
  label.
- **Failure red:** Reserved for validation failures, endpoint failures, and an
  HTTPS-required restored endpoint. Failure copy and recovery action must make
  the meaning clear without color.
- **Success green:** Reserved for the authorized terminal state alongside the
  `checkmark.circle.fill` symbol and explicit authorization copy.

**The Semantic Color Rule.** Use SwiftUI semantic colors (`.primary`,
`.secondary`, `.tint`, `.orange`, `.red`, `.green`) through their named roles.
Never substitute a fixed palette, reuse a state color as ornament, or make
color the sole carrier of state.

## Typography

**Display Font:** San Francisco system text through SwiftUI Dynamic Type.

**Body Font:** San Francisco system text through SwiftUI Dynamic Type.

**Endpoint / Code Font:** System monospaced text (`.monospaced()` or
`.system(..., design: .monospaced)`).

**Character:** Quiet, factual, and legible at every accessibility size. The
application uses one native type family and lets the platform supply its optical
adjustments; it does not introduce a display face or a web-style scale.

### Hierarchy

- **Large title** (`.largeTitle`, system metrics): Apple TV state titles and
  the displayed OAuth user code. The authorization code is semibold,
  monospaced, and remains an explicit value rather than a decorative headline.
- **Headline** (`.headline`, system metrics): Terminal-state labels including
  ready, setup-required, and authorized states.
- **Body** (`.body`, system metrics): Form copy, instructions, field values,
  and error descriptions.
- **Footnote** (`.footnote.monospaced()`, system metrics): Secondary endpoint
  context in authorization states.
- **Endpoint value** (`.body.monospaced()`, system metrics): The selected
  endpoint in connection states. It can wrap vertically; it must not truncate
  an address to preserve a compact composition.

**The Endpoint Rule.** Render an endpoint or OAuth user code in system
monospaced type. Expose it as selectable text where the platform supports text
selection, and provide an accessibility label and complete value. Never hide,
truncate, or convert it into decorative metadata.

## Elevation

The system is flat by authorship and layered by the platform. Grouped `Form`
surfaces, navigation containers, buttons, sheets, focus rings, and system
materials supply any needed depth. Apple TV uses a plain scrolling column and
the platform focus effect. Nama defines no custom shadows, blur treatments, or
elevated-card vocabulary.

**The Native Material Rule.** Use the platform’s standard grouped surfaces and
focus treatment when depth is needed. Decorative Liquid Glass, hand-rolled
blur, floating panels, and shadowed card stacks are prohibited.

## Components

### Navigation and Form Surface

- **Shared presentation:** iPhone, iPad, and Mac use a `NavigationStack` and
  grouped `Form`. Navigation titles name the current task: **Connect to Nama**,
  **Nama Endpoint**, or **Authorize Nama**.
- **Television presentation:** Apple TV uses a `NavigationStack` with a
  scrollable, leading-aligned column. Content is capped at 900pt, padded by
  64pt, with 28pt between state sections and 20pt between actions.
- **State behavior:** Presentation follows the feature’s safe state rather
  than a generic wizard step count. A state may replace the form entirely when
  it needs confirmation, recovery, or blocked-restoration guidance.

### Endpoint Field

- **Style:** Native `TextField` in a named **Nama endpoint** form section,
  with the visible prompt `https://nama.example.com`.
- **Input behavior:** URL content type, autocorrection disabled, never
  auto-capitalized, URL keyboard and Go submit label on iOS.
- **Validation:** The field keeps the entered address visible. A validation
  message is adjacent to the field and uses failure color only as a secondary
  signal.

### Endpoint Value

- **Style:** A native `LabeledContent` or vertically stacked label/value pair,
  with the address in system monospaced body text.
- **Long content:** Allow multiline vertical expansion. On non-tvOS surfaces,
  enable text selection; on tvOS, combine the label and value as one
  accessibility element.
- **Purpose:** The endpoint is the record being verified or authorized. It
  belongs beside the state that refers to it, never in hidden diagnostics or
  a decorative card.

### Actions

- **Affirmative action:** Use the native `.borderedProminent` style for the
  present state’s one affirmative action: **Connect**, **Continue**, **Play**,
  **Play This Source**, or **Retry**.
- **Recovery action:** Use a standard button for **Cancel** and **Change
  Endpoint**. Preserve the `.cancel` role where it communicates cancellation.
- **Focus:** Apple TV actions belong in one focus section with a state-derived
  default focus. Never rely on a gesture or hover state to reveal a critical
  action.

### Status and Warnings

- **In progress:** Use the native `ProgressView`, paired with the endpoint and
  any applicable local-HTTP warning.
- **Unencrypted local HTTP:** Use a `Label` with the prescribed SF Symbol,
  warning-orange foreground, explicit text, and a combined accessibility
  label. The warning persists while the selected endpoint requires it.
- **Authorized:** Use a green `checkmark.circle.fill` label with explicit copy
  that the device has scoped consumer access and was not granted Administrator
  access.
- **Failure and blocked restoration:** State the safe failure in plain
  language, retain the known endpoint, and expose only the recovery action the
  current state safely permits.

### Media Artwork and Details

- **Canonical identity:** Always render the canonical item title independently
  of artwork. Backdrop and poster failures retain stable title-bearing surfaces.
- **Task hierarchy:** Put identity and kind-valid concise metadata first. A
  Movie or Episode continues to Play or an availability state; a Show continues
  to Seasons and a Season to Episodes. Synopsis and supporting metadata follow.
- **Hierarchy:** Parent links come only from canonical Details. Child rows keep
  server display order and explicit loading or later-page recovery. Season rows
  prefer safe textless posters; Episode rows prefer safe textless thumbnails;
  both retain title-bearing fallbacks. Apple TV retains one stable focusable
  **Load More** item while pages append.
- **Sources:** Keep primary Play direct when one available default is enough.
  Otherwise use a typed child destination with standard focusable buttons for
  each neutral source summary. Load technical details only after selection,
  retain the source list through closed failure states, omit absent optional
  values, and never render opaque IDs, provider values, filesystem paths, or
  stream indexes.
- **Technical hierarchy:** Present Source aggregate metadata before ordered
  Parts and normalized Tracks. Use `LabeledContent`, system number and duration
  formatting, plain-language availability, and explicit **Try Again** or
  **Authorize Again** recovery. Unknown future technical values remain visible
  as unknown rather than replacing the destination.
- **Credits:** Keep Directors and Writers concise. Bound initial Cast and reveal
  complete ordered credits inline through an explicit button, never a modal.
- **Playback boundary:** A visible Play control emits an app-owned intent only.
  Primary Details Play leaves the canonical default implicit; **Play This
  Source** carries the deliberately chosen opaque source ID. Details never
  adopts player or playback-engine presentation.

## Do's and Don'ts

### Do:

- **Do** use `NavigationStack`, grouped forms, standard buttons, `ProgressView`,
  `Label`, `LabeledContent`, and SF Symbols before considering custom controls.
- **Do** render the selected endpoint beside every verification or
  authorization state in selectable, accessible monospaced text.
- **Do** use `.borderedProminent` only for the current affirmative action and
  leave cancellation and endpoint replacement visually secondary.
- **Do** pair warning, failure, and success color with plain-language text and
  a symbol; preserve the meaning for VoiceOver and increased-contrast users.
- **Do** keep the same state and action vocabulary across connection,
  authorization, Home, and canonical media Details on iPhone, iPad, Apple TV,
  and Mac while adapting only layout and focus.
- **Do** let system Dynamic Type, semantic colors, focus effects, and reduced
  motion determine platform adaptation.

### Don't:

- **Don't** turn connection into an integration dashboard, ornamental setup
  wizard, or generic card grid.
- **Don't** introduce decorative Liquid Glass, custom shadow stacks, fixed hex
  palette tokens, a display font, or a web-style component treatment.
- **Don't** create provider-branded client screens, provider-specific imagery,
  raw networking diagnostics, or reusable credential material in the
  presentation.
- **Don't** make a critical action depend on an undiscoverable gesture,
  hover-only affordance, color alone, or a platform-specific interaction that
  does not exist on another supported surface.
- **Don't** show speculative Library, Search, Watch State, playback execution,
  or unsupported media behavior as a placeholder. Home and canonical media
  Details show only their implemented stored-canonical behavior.
- **Don't** imply that authorization grants Administrator access, or add a
  browser/password step to the Apple-device flow.
