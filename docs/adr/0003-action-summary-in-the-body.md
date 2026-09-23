# The action summary rides in the body, because the result type is closed

When a target's actions change the document, the caller has to be able to tell which page it received,
but the fetch result (`url`, `statusCode`, `body.content`, `truncated`) is a closed shape owned by
`dsh-web` and a plugin cannot add fields to it — so the only channel the caller can actually see is the
body, and we prepend exactly one blockquote line naming the actions that ran and the document they
ended on. Logging the same thing to stderr instead was rejected because the caller cannot see logs, and
`statusCode`/`url` alone would silently describe two different documents at once. This is recorded
because that line looks like stray metadata, and the next reader's instinct will be to move it into a
result field that does not exist for plugins.
