# Animated hero for the README: storm sky → radar loop → hazard map → hazards.
Output "docs/media/hero.gif"
Source "docs/tapes/_theme.tape"
Set Framerate 20
Source "docs/tapes/_setup.tape"

Type "weather-outlook Miami --simulate storm" Sleep 400ms Enter
Sleep 5.5s
# VHS reports Sixel support but can't capture image layers, so use text-cell radar.
Type "4"
Sleep 300ms
Type "i"
Sleep 6s
Type "5"
Sleep 4.5s
Type "6"
Sleep 3.5s
Type "q"
Sleep 300ms
