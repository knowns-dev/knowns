import { beforeAll, describe, expect, test } from "bun:test";
import { Engine } from "../../../src/domain/codegen/index.ts";
import { askGo, GO_ORACLE, type OracleResponse } from "./oracle.ts";

interface Case {
  name: string;
  tpl: string;
  vars?: Record<string, string>;
}

const V = {
  name: "my cool-name",
  Pascal: "XMLParser",
  yes: "true",
  no: "FALSE",
  zero: "0",
  empty: "",
  num: "42",
  uni: "héllo wörld ǅ İstanbul",
};

const cases: Case[] = [
  { name: "plain text", tpl: "no actions here\n" },
  { name: "bare var", tpl: "Hi {{name}}!", vars: V },
  { name: "missing var", tpl: "[{{nothing}}]", vars: V },
  { name: "dotted var", tpl: "[{{a.b}}]", vars: { "a.b": "x" } },
  { name: "dot field", tpl: "[{{.name}}] [{{.nothing}}]", vars: V },
  { name: "dot whole map", tpl: "{{.}}", vars: V },
  { name: "dot whole map bool", tpl: "{{.}}", vars: { a: "TRUE", b: "x" } },
  { name: "camelCase", tpl: "{{camelCase name}}", vars: V },
  { name: "pascalCase", tpl: "{{pascalCase name}}", vars: V },
  { name: "kebabCase", tpl: "{{kebabCase Pascal}}", vars: V },
  { name: "snakeCase", tpl: "{{snakeCase Pascal}}", vars: V },
  { name: "upperCase", tpl: "{{upperCase uni}}", vars: V },
  { name: "lowerCase", tpl: "{{lowerCase uni}}", vars: V },
  { name: "startCase", tpl: "{{startCase uni}}", vars: V },
  {
    name: "startCase nums",
    tpl: "{{startCase a1b2Cd}} {{camelCase foo_barBaz}}",
    vars: { a1b2Cd: "a1b2Cd", foo_barBaz: "foo_barBaz" },
  },
  { name: "helper missing var", tpl: "{{camelCase nothing}}", vars: V },
  { name: "helper on bool", tpl: "{{camelCase yes}}", vars: V },
  { name: "helper literal arg", tpl: '{{camelCase "hello world"}}' },
  { name: "helper multi arg", tpl: "{{camelCase name name}}", vars: V },
  { name: "helper no arg", tpl: "{{camelCase}}", vars: V },
  { name: "helper pipeline", tpl: '{{"hello world" | pascalCase}}' },
  { name: "triple brace", tpl: "{{{name}}} {{{camelCase name}}}", vars: V },
  { name: "if true", tpl: "{{#if yes}}A{{else}}B{{/if}}", vars: V },
  { name: "if false string", tpl: "{{#if no}}A{{else}}B{{/if}}", vars: V },
  { name: "if empty", tpl: "{{#if empty}}A{{else}}B{{/if}}", vars: V },
  { name: "if missing", tpl: "{{#if nothing}}A{{else}}B{{/if}}", vars: V },
  { name: "if zero string", tpl: "{{#if zero}}A{{else}}B{{/if}}", vars: V },
  { name: "if no else", tpl: "x{{#if yes}}A{{/if}}y", vars: V },
  { name: "unless", tpl: "{{#unless no}}A{{else}}B{{/unless}}", vars: V },
  { name: "unless zero", tpl: "{{#unless zero}}A{{else}}B{{/unless}}", vars: V },
  { name: "unless missing", tpl: "{{#unless nothing}}A{{else}}B{{/unless}}", vars: V },
  { name: "unless multi token", tpl: "{{#unless a b}}A{{/unless}}", vars: V },
  { name: "else if", tpl: "{{#if no}}A{{else if yes}}B{{else}}C{{/if}}", vars: V },
  { name: "each over string", tpl: "{{#each name}}x{{/each}}", vars: V },
  { name: "each over missing", tpl: "{{#each nothing}}x{{else}}none{{/each}}", vars: V },
  {
    name: "each over dot",
    tpl: "{{#each .}}[{{.}}]{{/each}}",
    vars: { a: "1", b: "two", c: "true" },
  },
  { name: "each over num via range", tpl: "{{range 3}}[{{.}}]{{end}}" },
  {
    name: "range with vars",
    tpl: "{{range $i, $e := .}}{{$i}}={{$e}};{{end}}",
    vars: { a: "1", b: "x" },
  },
  { name: "range break", tpl: "{{range 5}}{{if eq . 3}}{{break}}{{end}}{{.}}{{end}}" },
  { name: "range continue", tpl: "{{range 5}}{{if eq . 3}}{{continue}}{{end}}{{.}}{{end}}" },
  { name: "range else", tpl: "{{range 0}}x{{else}}empty{{end}}" },
  { name: "range two vars on int", tpl: "{{range $i, $e := 3}}x{{end}}" },
  { name: "with", tpl: "{{#with name}}[{{.}}]{{/with}}", vars: V },
  { name: "with missing", tpl: "{{#with nothing}}[{{.}}]{{/with}}", vars: V },
  { name: "with else", tpl: "{{with .empty}}x{{else}}none{{end}}", vars: V },
  { name: "block comment", tpl: "a{{!-- hidden {{x}} --}}b", vars: V },
  { name: "line comment", tpl: "a{{! hidden }}b", vars: V },
  { name: "go comment", tpl: "a{{/* c */}}b" },
  { name: "unclosed comment", tpl: "a{{/* c }}b" },
  { name: "unknown function", tpl: "{{foo bar}}" },
  { name: "unknown function noarg multi", tpl: "x\n{{foo}}" },
  { name: "unknown function nested", tpl: "{{camelCase (foo name)}}", vars: V },
  { name: "unclosed action", tpl: "hello {{name" },
  { name: "unclosed action line 3", tpl: "a\nb\nc {{name" },
  { name: "unclosed quote", tpl: '{{printf "abc}}' },
  { name: "unterminated raw", tpl: "{{print `abc}}" },
  { name: "bad character", tpl: "{{name$}}" },
  { name: "bad char hash", tpl: "{{ # }}" },
  { name: "bad number", tpl: "{{print 1a}}" },
  { name: "unexpected right paren", tpl: "{{print )}}" },
  { name: "unclosed paren", tpl: "{{print (index . 1}}" },
  { name: "nested parens", tpl: '{{camelCase (index . "name")}}', vars: V },
  { name: "deep nested parens", tpl: '{{print (printf "%s" (index . "name"))}}', vars: V },
  { name: "trim markers", tpl: "a   {{- name -}}   b\n  {{- yes}}  ", vars: V },
  { name: "trim marker with if", tpl: "x\n{{- if .yes -}}\n  y\n{{- end -}}\nz", vars: V },
  { name: "bool var true", tpl: "{{yes}} {{no}}", vars: V },
  { name: "bool var if via dot", tpl: "{{if .yes}}T{{else}}F{{end}}", vars: V },
  { name: "stray else", tpl: "a {{else}} b" },
  { name: "stray end", tpl: "a {{end}} b" },
  { name: "mismatched end", tpl: "{{#if yes}}a{{/each}}", vars: V },
  { name: "missing end", tpl: "{{#if yes}}a", vars: V },
  { name: "missing end line", tpl: "x\ny\n{{#each a}}z", vars: V },
  { name: "eq string", tpl: '{{if eq name "my cool-name"}}same{{else}}diff{{end}}', vars: V },
  { name: "eq via index", tpl: '{{if eq (index . "name") "x"}}same{{else}}diff{{end}}', vars: V },
  { name: "eq multi", tpl: '{{if eq .num "1" "42"}}in{{else}}out{{end}}', vars: V },
  { name: "eq mismatch types", tpl: '{{if eq .yes "x"}}a{{end}}', vars: V },
  { name: "eq one arg", tpl: "{{eq .num}}", vars: V },
  { name: "eq nil", tpl: "{{eq .nothing .alsonothing}}", vars: V },
  { name: "eq int", tpl: "{{eq 1 1}} {{eq 1 2}} {{ne 1 2}}" },
  { name: "lt gt", tpl: '{{lt 1 2}} {{gt 1 2}} {{le 2 2}} {{ge 1 2}} {{lt "a" "b"}}' },
  { name: "lt bool", tpl: "{{lt true false}}" },
  { name: "lt mixed", tpl: '{{lt 1 "a"}}' },
  { name: "lt float int", tpl: "{{lt 1.5 2}}" },
  {
    name: "and or",
    tpl: "{{and .yes .num}} {{or .empty .num}} {{and .empty .num}} {{or .nothing .alsonothing}}",
    vars: V,
  },
  { name: "and in if", tpl: "{{if and .yes .num}}both{{end}}", vars: V },
  { name: "or pipeline", tpl: '{{.nothing | or "dflt"}}', vars: V },
  {
    name: "not",
    tpl: "{{not .yes}} {{not .empty}} {{not .nothing}} {{not .zero}} {{not 0}} {{not 1}} {{not .}}",
    vars: V,
  },
  { name: "not no args", tpl: "{{not}}", vars: V },
  { name: "not two args", tpl: "{{not 1 2}}", vars: V },
  { name: "printf", tpl: '{{printf "%s=%d|%5.2f|%q|%v|%x" "a" 42 3.14159 "q" true "hi"}}' },
  { name: "printf var", tpl: '{{printf "%s-%s" .name .num}}', vars: V },
  { name: "printf missing arg", tpl: '{{printf "%s %s" "a"}}' },
  { name: "printf extra arg", tpl: '{{printf "%s" "a" "b" 3}}' },
  { name: "printf bad verb", tpl: '{{printf "%d" "str"}} {{printf "%z" 1}} {{printf "%s" 5}}' },
  {
    name: "printf flags",
    tpl: '{{printf "[%-6s][%6s][%06d][%+d][% d][%#x][%#o][%b][%c][%U][%e][%g]" "ab" "cd" 42 7 7 255 8 5 65 0x1F600 1234.5678 0.000001}}',
  },
  { name: "printf star", tpl: '{{printf "[%*d][%-*d][%.*f]" 5 42 5 42 2 3.14159}}' },
  { name: "printf percent", tpl: '{{printf "100%% %"}}' },
  { name: "printf nil", tpl: '{{printf "%v %s %d" .nothing .nothing .nothing}}', vars: V },
  {
    name: "printf float",
    tpl: '{{printf "%v %v %v %v" 1.0 1e6 1e21 123456789.0}} {{printf "%v" 0.1}} {{printf "%.3g" 1234.5678}} {{printf "%g" 100000.0}} {{printf "%G" 1e-7}}',
  },
  { name: "printf T", tpl: '{{printf "%T %T %T %T %T" "a" 1 1.5 true .}}', vars: V },
  { name: "printf unicode", tpl: '{{printf "%q %+q %x %X % x" "héllo" "héllo" "hé" "hé" "hé"}}' },
  { name: "printf map", tpl: '{{printf "%v %s" . .}}', vars: { b: "x", a: "true" } },
  { name: "printf width unicode", tpl: '{{printf "[%5s][%-5s][%.2s]" "hé" "hé" "héllo"}}' },
  { name: "print", tpl: '{{print "a" 1 2 "b" "c" 3.5 true}}' },
  { name: "print nil", tpl: "{{print .nothing}}", vars: V },
  { name: "println", tpl: '{{println "a" 1 true}}|' },
  { name: "html", tpl: '{{html "<a href=\\"x\\">&\'</a>"}} {{html .nothing 1 "a"}}', vars: V },
  { name: "js", tpl: '{{js "it\'s <b>\\"x\\"</b> & = \\\\ \\n é \\u2028 😀"}}' },
  { name: "urlquery", tpl: '{{urlquery "a b&c=d/é~-_." 1}}' },
  { name: "len", tpl: '{{len "héllo"}} {{len .}}', vars: V },
  { name: "len int", tpl: "{{len 3}}" },
  { name: "index map", tpl: '{{index . "name"}} [{{index . "nothing"}}]', vars: V },
  { name: "index string", tpl: '{{index "abc" 1}} {{index "abc" 3}}' },
  { name: "index bad", tpl: '{{index "abc" -1}} ' },
  { name: "index bad type", tpl: '{{index "abc" "x"}}' },
  { name: "index of int", tpl: "{{index 1 2}}" },
  { name: "index chain missing", tpl: '{{index . "nothing" "x"}}', vars: V },
  { name: "index bool key", tpl: "{{index . true}}", vars: V },
  { name: "slice", tpl: '{{slice "abcdef" 1 3}} {{slice "abcdef" 2}} {{slice "abc"}}' },
  { name: "slice bad", tpl: '{{slice "abc" 2 1}}' },
  { name: "slice oob", tpl: '{{slice "abc" 5}}' },
  { name: "slice 3", tpl: '{{slice "abc" 1 2 3}}' },
  { name: "slice not string", tpl: "{{slice 5 1}}" },
  { name: "variables", tpl: '{{$x := "hi"}}{{$x}} {{$y := 5}}{{$y}}{{$x = "yo"}}{{$x}}' },
  { name: "undefined variable", tpl: "{{$nope}}" },
  { name: "variable field", tpl: "{{$x := .}}{{$x.name}}", vars: V },
  { name: "variable $", tpl: "{{$}}", vars: { b: "x" } },
  { name: "field of string", tpl: "{{.name.first}}", vars: V },
  { name: "field with args", tpl: "{{.name 1}}", vars: V },
  { name: "chain", tpl: '{{(index . "name").x}}', vars: V },
  { name: "number print", tpl: "{{1}} {{1.5}} {{0x10}} {{1e3}} {{010}} {{'a'}} {{-3}} {{1_000}}" },
  { name: "bool const", tpl: "{{true}} {{false}} {{nil}}" },
  { name: "nil arg", tpl: "{{print nil}} {{camelCase nil}}" },
  { name: "string const cmd", tpl: '{{"a\\tb"}} {{`raw\\n`}}' },
  { name: "complex", tpl: '{{1i}} {{printf "%v" 1i}}' },
  { name: "non executable pipeline", tpl: '{{.name | "x"}}', vars: V },
  { name: "arg to non function", tpl: '{{"a" "b"}}' },
  { name: "dot arg", tpl: "{{print . 1}}", vars: { a: "1" } },
  { name: "empty action", tpl: "a{{}}b" },
  { name: "empty pipeline paren", tpl: "{{print ()}}" },
  { name: "define template", tpl: '{{define "T"}}<{{.}}>{{end}}{{template "T" .name}}', vars: V },
  { name: "template missing", tpl: '{{template "nope"}}' },
  { name: "block", tpl: '{{block "b" .name}}[{{.}}]{{end}}', vars: V },
  { name: "define multi", tpl: '{{define "T"}}a{{end}}{{define "T"}}b{{end}}' },
  { name: "break outside range", tpl: "{{break}}" },
  { name: "declare in range 3", tpl: "{{range $a, $b, $c := .}}{{end}}" },
  { name: "range only vars", tpl: "{{range $a, 5 := .}}{{end}}" },
  { name: "unicode text", tpl: "héllo {{name}} 😀 {{camelCase uni}}", vars: V },
  { name: "unicode error col", tpl: "héllo 😀 {{camelCase nothing}}", vars: V },
  { name: "multi line error", tpl: "line1\nline2 {{name}}\nline3 {{foo}}\n" },
  { name: "multi line exec error", tpl: "line1\n  line2 {{camelCase nothing}}\n", vars: V },
  { name: "exec error in range", tpl: "{{range 2}}{{camelCase nothing}}{{end}}", vars: V },
  { name: "exec error call", tpl: '{{index "abc" 10}}' },
  { name: "wrong type for value", tpl: "{{camelCase 5}}" },
  { name: "wrong type bool var", tpl: "{{upperCase .yes}}", vars: V },
  { name: "expected string", tpl: "{{printf 5}}" },
  { name: "elseif missing", tpl: "{{if 1}}a{{else if}}b{{end}}" },
  { name: "if no pipeline", tpl: "{{if}}a{{end}}" },
  { name: "else extra", tpl: "{{if 1}}a{{else}}b{{else}}c{{end}}" },
  { name: "call", tpl: "{{call .name}}", vars: V },
  { name: "call none", tpl: "{{call}}" },
  { name: "dollar in text", tpl: "$1 and {{name}} \\ {", vars: V },
  { name: "single brace", tpl: "{ {name} }", vars: V },
  { name: "adjacent actions", tpl: "{{name}}{{name}}{{num}}", vars: V },
  { name: "hbs this", tpl: "{{this}}", vars: V },
  { name: "hbs at index", tpl: "{{#each a}}{{@index}}{{/each}}", vars: V },
  { name: "hbs partial", tpl: "{{> partial}}", vars: V },
  { name: "hbs else bare", tpl: "{{#if yes}}A{{else}}B{{/if}}", vars: V },
  { name: "hbs helper known with arg dotted", tpl: "{{camelCase a.b}}", vars: { "a.b": "x y" } },
  { name: "hbs helper with literal", tpl: "{{camelCase 123}}" },
  { name: "hbs helper case", tpl: "{{upperCase name}}-{{lowerCase Pascal}}", vars: V },
  { name: "path-like", tpl: "src/{{kebabCase name}}/{{pascalCase name}}.ts", vars: V },
  { name: "if with eq helper", tpl: '{{#if eq num "42"}}yes{{/if}}', vars: V },
  { name: "if with and", tpl: "{{#if and yes num}}yes{{/if}}", vars: V },
  { name: "tab and newline in action", tpl: "{{\n name \n}}", vars: V },
  { name: "carriage returns", tpl: "a\r\n{{name}}\r\n", vars: V },
  { name: "empty template", tpl: "" },
  { name: "whitespace only", tpl: "  \n " },
  { name: "percent in text", tpl: "100% {{name}} %d", vars: V },
  {
    name: "dot in range over map values",
    tpl: "{{range .}}<{{.}}>{{end}}",
    vars: { b: "2", a: "1", C: "3" },
  },
  { name: "with dot map", tpl: "{{with .}}{{.a}}{{end}}", vars: { a: "z" } },
  {
    name: "var shadow in with",
    tpl: "{{$x := 1}}{{with .a}}{{$x := 2}}{{$x}}{{end}}{{$x}}",
    vars: { a: "z" },
  },
  { name: "range assign", tpl: "{{$s := 0}}{{range 3}}{{$s = .}}{{end}}{{$s}}" },
  { name: "multi-line action error", tpl: 'a\n{{ print\n  "x\n}}' },
  { name: "multi-line unclosed action", tpl: "a\n{{ print\n  1\n" },
  { name: "long token", tpl: "{{ print 1 aVeryLongIdentifierName }}" },
  { name: "unexpected char token", tpl: "{{ print , }}" },
  { name: "unexpected in operand", tpl: "{{ print 1 }" },
  { name: "assign without decl", tpl: "{{ $x = 1 }}" },
  { name: "bad declare", tpl: "{{ $x : 1 }}" },
  { name: "dot after term", tpl: "{{ print 1.x }}" },
  { name: "dot after string", tpl: '{{ "a".x }}' },
  { name: "char const", tpl: "{{ 'ab' }} {{ '\\n' }} {{ print 'x' }}" },
  { name: "bad rune", tpl: "{{ ' }}" },
  { name: "unicode ident", tpl: "{{ héllo }}" },
  { name: "hbs unicode var", tpl: "{{héllo}} {{camelCase héllo}}", vars: { héllo: "a b" } },
  { name: "template tabs", tpl: "{{\tname\t}}", vars: V },
  { name: "right trim only", tpl: "a {{name -}}   \n  b", vars: V },
  { name: "left trim only", tpl: "a  \n  {{- name}} b", vars: V },
  { name: "trim at start", tpl: "{{- name}}", vars: V },
  { name: "trim marker minus number", tpl: "{{-3}} {{ -3 }}" },
  { name: "break outside via hbs", tpl: "{{#if x}}{{break}}{{/if}}", vars: V },
  { name: "range over map decl", tpl: "{{range $k := .}}{{$k}}{{end}}", vars: { a: "1" } },
  {
    name: "if else if with",
    tpl: "{{with .a}}A{{else with .b}}B{{else}}C{{end}}",
    vars: { b: "1" },
  },
  { name: "variable assign in if", tpl: "{{if $x := .a}}{{$x}}{{end}}", vars: { a: "q" } },
  { name: "pipe into field fn", tpl: '{{.a | printf "%s!"}}', vars: { a: "q" } },
  {
    name: "pipe three",
    tpl: '{{.a | printf "%s!" | upperCase | printf "[%s]"}}',
    vars: { a: "q" },
  },
  { name: "pipe wrong final", tpl: "{{.a | len | camelCase}}", vars: { a: "q" } },
  { name: "html pipe", tpl: '{{"<b>" | html}}' },
  { name: "unused decl pipeline", tpl: "{{$a := 1}}{{$b := $a}}x" },
  { name: "func in arg position", tpl: "{{print len}}" },
  { name: "wrong number args fixed", tpl: '{{len "a" "b"}} ' },
  { name: "wrong number args ne", tpl: "{{ne 1}}" },
  { name: "wrong args at least", tpl: "{{index}}" },
  {
    name: "fmt floats",
    tpl: '{{printf "%v|%v|%v|%v|%v" 0.5 100.0 1e20 1e-5 123456.789}} {{printf "%f|%.0f|%.1f|%8.3f|%-8.2f|" 3.14159 2.7 0.05 3.14159 2.5}} {{printf "%e|%.2e|%E" 123456.789 0.000123 5.0}} {{printf "%g|%.2g|%.10g" 0.00001234 1234567.0 1.0}}',
  },
  {
    name: "fmt ints",
    tpl: '{{printf "%d|%5d|%-5d|%05d|%x|%X|%o|%b|%c|%q|%U|%#U" 42 42 42 42 255 255 8 5 0x4e16 0x4e16 0x4e16 0x4e16}} {{printf "%+d|% d|%.5d|%8.3d|%#b|%#o|%O" 5 5 42 42 5 8 8}}',
  },
  {
    name: "fmt bool str",
    tpl: '{{printf "%t|%v|%5t|%-7t|" true false true false}} {{printf "%s|%10s|%-10s|%.3s|%q|%#q|%x|% X" "hello" "hello" "hello" "hello" "hi" "hi" "hi" "hi"}}',
  },
  { name: "fmt errors", tpl: '{{printf "%!|%z|%d|%s" 1 "a"}} {{printf "%.f %5.f" 2.5 3.5}}' },
  { name: "fmt width on bad", tpl: '{{printf "%5d|%-5s|%05s|%5v" "x" 3 "ab" true}}' },
  { name: "fmt plus v", tpl: '{{printf "%+v %#v %#v" "s" "s" 5}}' },
  {
    name: "fmt sprint spacing",
    tpl: '{{print 1 2 "a" 3 "b" "c" 4 5.5 true false}}|{{println}}|{{print}}',
  },
  {
    name: "fmt rounding",
    tpl: '{{printf "%.0f %.0f %.0f %.0f %.1f %.1f %.2f %.3e %.2g %.1f %.20f %.3f" 0.5 1.5 2.5 3.5 0.25 0.35 1.005 2.5e10 2.5 0.05 0.1 1e15}} {{printf "%f %.2f %e" 1e22 123456789012345678901234.0 1e-320}} {{printf "%v %v %v" 5e-324 1.7976931348623157e308 0.000001}}',
  },
  { name: "fmt complex", tpl: '{{printf "%v %.1f %g" 1i 2i 3i}} {{print 1.5i}}' },
  {
    name: "fmt big int",
    tpl: "{{9223372036854775807}} {{-9223372036854775808}} {{9223372036854775808}}",
  },
  { name: "int overflow lit", tpl: "{{99999999999999999999}}" },
  {
    name: "uint8 values",
    tpl: '{{index "abc" 0}} {{printf "%c %v %T %d" (index "abc" 1) (index "abc" 1) (index "abc" 1) (index "abc" 2)}} {{eq (index "a" 0) 97}} {{lt (index "a" 0) 98}}',
  },
  { name: "range over uint8", tpl: '{{range (index "\x03" 0)}}{{.}}{{end}}' },
  {
    name: "range string key sort",
    tpl: "{{range $k, $v := .}}{{$k}},{{end}}",
    vars: { b: "1", B: "2", a: "3", é: "4" },
  },
];

const validateOnly: Case[] = [
  { name: "validate ok", tpl: "{{name}} {{#if x}}y{{/if}}" },
  { name: "validate bad fn", tpl: "{{foo}}" },
  { name: "validate unclosed", tpl: "{{#if x}}" },
  { name: "validate path", tpl: "src/{{kebabCase name}}.ts" },
  { name: "validate triple", tpl: "{{{a}}}" },
  { name: "validate comment", tpl: "{{!-- x --}}{{! y }}" },
  { name: "validate each", tpl: "{{#each a}}{{this}}{{/each}}" },
  { name: "validate with", tpl: "{{#with a}}x{{/with}}" },
  { name: "validate bad action", tpl: "{{ name | }}" },
  {
    name: "validate preprocessed shape",
    tpl: "{{camelCase a b}} {{upperCase (x)}} {{#unless a b}}z{{/unless}}",
  },
];

const engine = new Engine("/does/not/matter");

function tsRender(c: Case): { out: string; err: string } {
  try {
    return { out: engine.renderString(c.tpl, c.vars ?? {}), err: "" };
  } catch (e) {
    return { out: "", err: (e as Error).message };
  }
}

function tsValidate(c: Case): { out: string; err: string } {
  try {
    return { out: engine.validateTemplate(c.tpl), err: "" };
  } catch (e) {
    return { out: "", err: (e as Error).message };
  }
}

const suite = GO_ORACLE ? describe : describe.skip;

suite("codegen engine against the Go engine", () => {
  let renderGo: OracleResponse[] = [];
  let validateGo: OracleResponse[] = [];
  beforeAll(() => {
    renderGo = askGo(cases.map((c) => ({ op: "render", tpl: c.tpl, vars: c.vars ?? {} })));
    validateGo = askGo([...cases, ...validateOnly].map((c) => ({ op: "validate", tpl: c.tpl })));
  });

  cases.forEach((c, i) => {
    test(`render: ${c.name}`, () => {
      const go = renderGo[i];
      const ts = tsRender(c);
      expect({ out: ts.out, err: ts.err }).toEqual({
        out: go?.out ?? "<missing>",
        err: go?.err ?? "<missing>",
      });
    });
  });

  [...cases, ...validateOnly].forEach((c, i) => {
    test(`validate: ${c.name}`, () => {
      const go = validateGo[i];
      const ts = tsValidate(c);
      expect({ out: ts.out, err: ts.err }).toEqual({
        out: go?.out ?? "<missing>",
        err: go?.err ?? "<missing>",
      });
    });
  });
});

describe("codegen engine (no Go needed)", () => {
  test("renders the documented helpers", () => {
    const e = new Engine("/p");
    expect(
      e.renderString("{{camelCase name}} {{pascalCase name}} {{kebabCase name}}", {
        name: "my name",
      }),
    ).toBe("myName MyName my-name");
    expect(e.renderString("{{missing}}", {})).toBe("<no value>");
    expect(() => e.renderString("{{foo bar}}", {})).toThrow(/function "foo" not defined/);
  });
});
