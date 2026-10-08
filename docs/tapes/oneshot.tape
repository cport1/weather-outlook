# One-shot summary and the planet hazard map, as plain command output.
Output "docs/media/oneshot.mp4"
Source "docs/tapes/_theme.tape"
Set Height 1120
Source "docs/tapes/_setup.tape"

Type "weather-outlook Denver --once" Sleep 300ms Enter
Sleep 4s
Hide
Type "clear" Enter
Show
Type "weather-outlook hazards" Sleep 300ms Enter
Sleep 6s
