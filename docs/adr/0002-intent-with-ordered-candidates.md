# An action is an intent with ordered candidates, not a selector

Every action names an intent (what it wants to achieve) and a list of candidates (CSS selector, visible
label, role), tried in order until one is present and visible. A target therefore describes what the
page must do rather than where the markup happens to be, which is what lets a recipe survive a redesign
— a plain selector would break on the next front-end change, and the plugin has already been bitten by
markup assumptions once (a product page whose copy sat past a byte cap). We accepted the cost: a
candidate list is wordier than one selector, and ambiguity between candidates has to be resolved by
order rather than by asking the page.
