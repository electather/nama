# Apple connection acceptance

Status: incomplete. A physical iPhone connection flow is exercised below. The
application icon, physical iPad, Apple TV, Mac application, VPN,
reverse-proxy, hardware-keyboard, and pointer rows remain unverified blockers.
Simulator evidence is not used as Local Network privacy proof.

## Evidence boundary

- Device: physical iPhone 14 Pro Max (`iPhone15,3`) on iOS 26.6, installed
  through Xcode with free Personal Team provisioning.
- Native publisher: the TypeScript core ran natively on the Mac at
  `http://192.168.1.164:8080/` with LAN discovery enabled. The repository's
  real Apple `NWBrowser` fixture independently read that exact canonical TXT
  `url` before the phone flow began.
- Physical interaction results below are operator-observed on that iPhone.
- `mise run check:ios` passed the focused Apple tests and signing-disabled iOS,
  tvOS, and macOS builds before this acceptance pass. `mise run check:swift`
  also passed lint and type analysis.
- The local Administrator used only reserved test identity data. Setup and
  subsequent authentication status succeeded through the explicit
  `issue127-local` profile at `http://127.0.0.1:8080`; the CLI correctly warned
  that this loopback HTTP transport was unencrypted.

## Physical iPhone connection matrix

| Behavior | Result | Evidence |
| --- | --- | --- |
| Local Network denial | Passed | The first **Find Nama on Local Network** action produced the iOS prompt. Choosing **Don’t Allow** showed **Local Network Access Is Off**, **Open Settings**, and the still-usable manual field. |
| Later Settings change | Passed | Enabling Local Network from the app's Settings surface and returning to Nama resumed scanning without a relaunch. |
| Native LAN discovery | Passed | After explicit activation, the app displayed `http://192.168.1.164:8080/` from the native publisher and waited for an explicit candidate tap before verification. |
| Explicit discovered selection | Passed | Selecting the candidate verified only that endpoint and initially showed **Finish setting up Nama**. |
| Setup-required restoration | Passed | Force-quitting and relaunching automatically reverified the saved endpoint and returned to setup-required without a visible repeat or loop. |
| Offline restoration | Passed | With the native server stopped, relaunch retained the endpoint and showed the cannot-connect failure with **Retry** and **Change Server**. |
| Retry after recovery | Passed | Restarting the native server and activating **Retry** performed a new verification and returned to setup-required. |
| Change Server | Passed | **Change Server** returned to endpoint selection, cleared the saved endpoint, and prevented restoration after the next relaunch. |
| Manual LAN entry | Passed | Entering `http://192.168.1.164:8080/` manually used the same verifier and reached setup-required. |
| Ready state | Passed | After Administrator initialization through the public setup contract, a new discovered verification showed **Nama is ready**. |
| Ready restoration | Passed | Force-quitting and relaunching reverified the saved initialized endpoint and returned to ready. |
| Verification cancellation | Passed | Canceling an active request to `http://192.0.2.1/` returned silently to endpoint selection; no stale failure appeared and the address was not persisted. |
| Verification loading | Passed | Progress and endpoint context were understandable while **Cancel** and **Change Server** remained reachable. |
| Invalid manual input | Passed | `nama.local` stayed on endpoint selection and showed **Enter a valid HTTP or HTTPS server address.** without starting verification. |
| Long endpoint | Passed | A deliberately long valid HTTPS hostname and reverse-proxy path remained readable on the terminal failure surface without clipping or hiding recovery actions. |

## Discovery-state matrix

| State or transition | Result | Evidence |
| --- | --- | --- |
| Scanning | Passed | With the publisher stopped, explicit discovery first showed **Looking for Nama servers…**. |
| Empty | Passed | The scan changed to **No Nama servers found** after about two seconds while manual entry remained usable. |
| Late candidate | Passed | Restarting the publisher while the empty state was visible surfaced the candidate without another Find action. |
| Candidate removal | Passed | Stopping the final publisher removed its candidate and returned directly to empty without repeating the initial delay. |
| Permission denied | Passed | Physical iOS privacy denial produced the approved guidance and Settings action. |
| Discovery recovery | Passed | Enabling permission in Settings and returning to the foreground restarted active discovery correctly. |

## Verification-state matrix

| State | Result | Evidence |
| --- | --- | --- |
| Loading | Passed | Physical verification showed progress, endpoint context, Cancel, and Change Server. |
| Cannot connect | Passed | Physical offline restoration retained the endpoint and exposed both recovery actions. |
| Nama unavailable | Passed | A LAN Connect fixture returned `unavailable`; the app showed **Nama is temporarily unavailable. Try again.** |
| Incompatible | Passed | A reachable non-Connect LAN fixture showed **This address did not respond as a compatible Nama server.** |
| Setup required | Passed | The fresh native server produced the setup-required terminal state through discovery, restoration, retry, and manual entry. |
| Ready | Passed | The initialized native server produced ready through discovery and launch restoration. |
| Cancellation | Passed | Local cancellation was silent and stale completion did not replace editing. |
| Offline restoration | Passed | The saved endpoint survived server unavailability and remained retryable or explicitly changeable. |

## Physical iPhone accessibility and input

| Inspection | Result | Evidence |
| --- | --- | --- |
| VoiceOver ready state | Passed | VoiceOver read ready status, Endpoint with its full value, and Change Server in logical order; the action was announced and activatable as a button. |
| VoiceOver entry flow | Passed | Candidate URL/service name, manual endpoint field, and Find/Connect actions were meaningful, ordered, and activatable. |
| Dynamic Type | Passed | At the largest accessibility text size, entry and long-address failure content reflowed or scrolled without clipping or unreachable critical actions. |
| Contrast | Passed | Light, Dark, and Increase Contrast inspections kept primary, secondary, validation, failure, field, and button states readable without color-only meaning. |
| Touch and software keyboard | Passed | Discovery selection, buttons, Settings transition, manual editing, submission, Retry, Change Server, relaunch, and cancellation were exercised physically. |
| Hardware keyboard | Unverified | No hardware keyboard was available. |
| Pointer | Unverified | No pointer was available. |

## Explicit blockers

| Required row | Status | Missing prerequisite |
| --- | --- | --- |
| Final application icon | Blocked | The supplied iOS PNG exports are 2048×2048, contain alpha, and bake rounded transparent corners into flattened previews. The owner-approved Icon Composer `.icon` source or a full-bleed opaque 1024×1024 sRGB PNG is still required. |
| Physical iPad | Unverified | No physical iPad was available. |
| Apple TV | Unverified | Explicitly deferred for this pass; no remote-focus or tvOS runtime row is claimed. |
| Physical Mac application | Unverified | The Mac hosted and advertised the native server, but its application, App Sandbox, Local Network privacy, Settings recovery, input, and accessibility matrix was not exercised. |
| VPN manual endpoint | Unverified | No platform-trusted VPN Nama endpoint was available. |
| Reverse-proxy manual endpoint | Unverified | No platform-trusted reverse-proxy Nama endpoint was available. |
| Hardware keyboard and pointer | Unverified | No external input accessories were available for the iPhone. |
| Aggregate completion | Blocked | Issue acceptance remains incomplete until every blocker above is exercised or supplied; no unrun row is treated as passing. |
