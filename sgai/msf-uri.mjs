// URI fragment variable substitution, per draft-ietf-moq-msf's Variable
// Substitution section: catalog fields (or other subscriber-visible strings,
// like a segmentation_upid_uri) may carry %varname% placeholders, resolved
// client-side from the fragment (the part after '#') of the URI the
// subscriber connected with -- never from a query parameter. Example from the
// draft: `moqt://relay.example.com/live#namespace--name&token=XYZ789` resolves
// a field containing `%token%` to `XYZ789`.
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
