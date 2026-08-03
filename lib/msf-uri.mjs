// MOQ URL helpers, shared by csai/ (in-container) and sgai/ (host-side)
// scripts: parsing/building moqt:// URLs per the ns=/t= query convention
// shown in the architecture slides (e.g.
// moqt://example.com/relay-app/relayID?ns=customerID/broadcastID&t=video),
// and draft-ietf-moq-msf's own %variable% fragment substitution mechanism
// (Variable Substitution section). The two are independent parts of the same
// URI -- query addresses a namespace/track, fragment carries subscriber-side
// personalization data -- and can be used together or apart.
//
// The ns=/t= query convention is only an informal example in the slides;
// draft-ietf-moq-msf's own ABNF (msf-uri = "moqt://" authority
// path-abempty ["?" query] "#" msf-fragment) leaves the query's internal
// structure unspecified. buildUri()/parseUri() adopt the slides' convention,
// adapted to this sandbox's flat broadcast naming: `namespace` is the
// broadcast path (not a hierarchical customerID/broadcastID pair -- this
// sandbox has no tenant/customer concept), `track` is optional and omitted
// when the target track isn't known in advance (e.g. an ad broadcast whose
// track name is only assigned by moq-cli at publish time).
const VARIABLE_PATTERN = /%([A-Za-z0-9_-]+)%/g;

// Parses the key=value pairs out of a URI's fragment. A segment without '='
// (e.g. a leading namespace/name addressing component, as in the draft's own
// example) is addressing info, not a substitution variable, and is ignored.
export function parseFragmentVars(url) {
    const hashIndex = url.indexOf("#");
    if (hashIndex === -1) return {};
    const fragment = url.slice(hashIndex + 1);
    const vars = {};
    for (const segment of fragment.split("&")) {
        const eq = segment.indexOf("=");
        if (eq === -1) continue;
        const key = segment.slice(0, eq);
        if (key) vars[decodeURIComponent(key)] = decodeURIComponent(segment.slice(eq + 1));
    }
    return vars;
}

// Replaces every %varname% in `str` with vars[varname]. A placeholder with no
// matching variable is left untouched -- resolution is best-effort, per the
// draft leaving unresolved-variable behavior to the application.
export function substitute(str, vars) {
    return str.replace(VARIABLE_PATTERN, (match, name) => (name in vars ? vars[name] : match));
}

// Builds a moqt:// URL with ns=/t= query params. `endpoint` is the connection
// URL (scheme+authority+path, e.g. "moqt://localhost"); `namespace` is the
// broadcast path; `track` is optional. Uses URL/URLSearchParams so special
// characters in namespace/track are encoded correctly -- unlike a %variable%
// fragment placeholder (see substitute() above), these are real values, not
// literal template syntax that must survive unencoded.
export function buildUri({ endpoint, namespace, track }) {
    const url = new URL(endpoint);
    if (namespace) url.searchParams.set("ns", namespace);
    if (track) url.searchParams.set("t", track);
    return url.toString();
}

// Parses a moqt:// URL's connection endpoint, namespace, and track back out
// -- the inverse of buildUri(). Fragment variables aren't included; read
// those separately via parseFragmentVars().
export function parseUri(uri) {
    const url = new URL(uri);
    const namespace = url.searchParams.get("ns");
    const track = url.searchParams.get("t");
    url.search = "";
    url.hash = "";
    return { endpoint: url.toString(), namespace, track };
}
