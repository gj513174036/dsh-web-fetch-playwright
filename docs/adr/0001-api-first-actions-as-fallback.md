# API first, actions as the fallback

When we need data at volume from a site we care about, we look for the site's own JSON API and build
the crawler on that; the action model exists for sites where no clean API can be found, and for
discovering the path to the data once. We rejected investing first in a general "drive any page with a
recorded script" capability, because its cost grows with every site and every redesign while an API
contract costs almost nothing to keep. This is recorded because the obvious-looking move — making the
action model the primary path — is exactly the maintenance burden the decision avoids.
