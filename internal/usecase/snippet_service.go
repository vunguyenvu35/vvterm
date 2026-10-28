package usecase

import "vvterm/internal/domain"

// SnippetService manages reusable shell scripts. Running a snippet is a UI concern: the script is
// typed into the focused terminal through SessionService.Write, so it needs no backend state.
type SnippetService struct{ c *Core }

func NewSnippetService(c *Core) *SnippetService { return &SnippetService{c} }

func (s *SnippetService) List() []domain.Snippet { return s.c.Store.ListSnippets() }

func (s *SnippetService) Save(x domain.Snippet) (domain.Snippet, error) {
	return s.c.Store.SaveSnippet(x)
}

func (s *SnippetService) Delete(id string) error { return s.c.Store.DeleteSnippet(id) }
