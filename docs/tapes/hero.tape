# Animated hero for the README: storm sky → radar loop → hazard map → hazards.
Output "docs/media/hero.gif"
Source "docs/tapes/_theme.tape"
Set Framerate 20
Source "docs/tapes/_setup.tape"

# Start off-camera so the GIF opens on the live dashboard, not a blank terminal.
Hide
Type "weather-outlook Miami --simulate storm" Enter
Sleep 4s
Show
Sleep 4s
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
