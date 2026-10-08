# Animated hero for the README: storm sky → radar loop → hazard map → hazards.
Output "docs/media/hero.gif"
Source "docs/tapes/_theme.tape"
Set Framerate 20
Source "docs/tapes/_setup.tape"

# Start off-camera so the GIF opens on the live dashboard. VHS's terminal
# advertises Sixel but can't capture images, so radar uses text cells.
Hide
Type "weather-outlook Miami --simulate storm --images off" Enter
Sleep 5s
Show
Sleep 4s
Type "4"
Sleep 6s
Type "5"
Sleep 4.5s
Type "6"
Sleep 3.5s
Type "q"
Sleep 300ms
