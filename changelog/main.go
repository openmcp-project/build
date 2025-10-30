package main

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"slices"
	"strings"
)

const (
	releaseNotePattern = "```" + `(?<type>[a-zA-z]+)(\((?<subtype>[a-zA-Z]+)\))?\s*(?<audience>[a-zA-Z]+)\s*(\r)?\n(?<body>.*)\n` + "```"

	SectionKeyOther    = "other"
	SubsectionKeyOther = "other"
)

var (
	releaseNoteRegex = regexp.MustCompile(releaseNotePattern)
)

func main() {
	if len(os.Args) != 2 {
		panic("expected exactly one argument: path to PR info JSON file")
	}

	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(fmt.Sprintf("failed to read PR info file: %v", err))
	}
	prs := []PRInfo{}
	if err := json.Unmarshal(data, &prs); err != nil {
		panic(fmt.Errorf("failed to unmarshal PR info JSON: %w", err))
	}

	sections := NewSections().
		WithSection("breaking", "🚨 Breaking").
		WithSection("feature", "🚀 Features").
		WithSection("bugfix", "🐛 Bugfixes").
		WithSection("refactor", "🛠️ Refactorings").
		WithSection("doc", "📚 Documentation").
		WithSection("chore", "🔧 Chores")

	for _, pr := range prs {
		prNotes := pr.ExtractReleaseNotes()
		for _, note := range prNotes {
			sections.Add(note)
		}
	}

	fmt.Print(sections.Render())
}

type PRInfo struct {
	Number int      `json:"number"`
	Title  string   `json:"title"`
	Body   string   `json:"body"`
	URL    string   `json:"url"`
	Author PRAuthor `json:"author"`
}

type PRAuthor struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Login string `json:"login"`
	IsBot bool   `json:"is_bot"`
}

type Sections struct {
	CustomSections map[string]*Section
	Other          *Section
	IterationOrder []string
}

type Section struct {
	ID    string
	Title string
	Notes []ReleaseNote
}

type ReleaseNote struct {
	PRInfo   *PRInfo
	Note     string
	Type     string
	Subtype  string
	Audience string
}

func NewSections() *Sections {
	ss := &Sections{
		CustomSections: map[string]*Section{},
		Other:          NewSection(SectionKeyOther, "➕ Other"),
		IterationOrder: []string{},
	}
	return ss
}

func (ss *Sections) WithSection(id, title string) *Sections {
	section := NewSection(id, title)
	ss.CustomSections[id] = section
	ss.IterationOrder = append(ss.IterationOrder, id)
	return ss
}

func NewSection(id, title string) *Section {
	section := &Section{
		ID:    id,
		Title: title,
		Notes: []ReleaseNote{},
	}
	return section
}

func (ss Sections) Add(note ReleaseNote) {
	section, ok := ss.CustomSections[note.Type]
	if !ok {
		section = ss.Other
	}
	section.Notes = append(section.Notes, note)
}

func (pri *PRInfo) ExtractReleaseNotes() []ReleaseNote {
	res := []ReleaseNote{}
	matches := releaseNoteRegex.FindAllStringSubmatch(pri.Body, -1)
	for _, match := range matches {
		note := ReleaseNote{
			PRInfo:   pri,
			Note:     normalizeLineEndings(match[releaseNoteRegex.SubexpIndex("body")]),
			Type:     strings.ToLower(match[releaseNoteRegex.SubexpIndex("type")]),
			Subtype:  strings.ToLower(match[releaseNoteRegex.SubexpIndex("subtype")]),
			Audience: strings.ToLower(match[releaseNoteRegex.SubexpIndex("audience")]),
		}
		if note.Note == "" || (len(note.Note) <= 6 && strings.ToUpper(strings.TrimSpace(note.Note)) == "NONE") {
			continue
		}
		res = append(res, note)
	}
	return res
}

func (ss *Sections) Render() string {
	var sb strings.Builder
	sb.WriteString("# Changelog\n\n\n")
	for _, sid := range ss.IterationOrder {
		section := ss.CustomSections[sid]
		sb.WriteString(section.Render())
	}
	sb.WriteString(ss.Other.Render())
	sb.WriteString("\n")
	return sb.String()
}

func (s *Section) Render() string {
	var sb strings.Builder
	if len(s.Notes) == 0 {
		return ""
	}
	sb.WriteString(fmt.Sprintf("## %s\n\n", s.Title))
	notesByAudience, audienceOrder := orderNotesByAudience(s.Notes)
	for _, audience := range audienceOrder {
		notes := notesByAudience[audience]
		sb.WriteString(fmt.Sprintf("#### [%s]\n", strings.ToUpper(audience)))
		for _, note := range notes {
			author := "@" + note.PRInfo.Author.Login
			if note.PRInfo.Author.IsBot {
				author = "⚙️"
			}
			sb.WriteString(fmt.Sprintf("- %s **(#%d, %s)**\n", indent(strings.TrimSpace(note.Note), 2), note.PRInfo.Number, author))
		}
	}
	sb.WriteString("\n")

	return sb.String()
}

func normalizeLineEndings(s string) string {
	return strings.ReplaceAll(s, "\r\n", "\n")
}

func indent(s string, spaces int) string {
	prefix := strings.Repeat(" ", spaces)
	lines := strings.Split(s, "\n")
	for i, line := range lines {
		lines[i] = prefix + line
	}
	return strings.Join(lines, "\n")
}

// orderNotesByAudience returns a mapping from audience to list of release notes for that audience
// and an alphabetically ordered list of audiences.
func orderNotesByAudience(notes []ReleaseNote) (map[string][]ReleaseNote, []string) {
	notesByAudience := map[string][]ReleaseNote{}
	for _, note := range notes {
		notesByAudience[note.Audience] = append(notesByAudience[note.Audience], note)
	}
	audiences := []string{}
	for audience := range notesByAudience {
		audiences = append(audiences, audience)
	}
	slices.Sort(audiences)
	return notesByAudience, audiences
}
