# Holds every dashboard view long enough to extract stills (scripts/readme-media.ts).
Output "docs/media/views.mp4"
Source "docs/tapes/_theme.tape"
Source "docs/tapes/_setup.tape"

Type "weather-outlook Miami --simulate storm" Enter
Sleep 6s
Type "2"
Sleep 3s
Type "3"
Sleep 3s
# VHS reports Sixel support but can't capture image layers, so use text-cell radar.
Type "4"
Sleep 300ms
Type "i"
Sleep 6s
Type "5"
Sleep 4s
Type "6"
Sleep 3s
Type "7"
Sleep 3s
Type "?"
Sleep 2s
Type "q"
Sleep 300ms
