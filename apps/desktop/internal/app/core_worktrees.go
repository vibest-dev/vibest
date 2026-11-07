package app

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"time"
	"vibest-desktop/internal/core"
)

func (a *App) localWorkspace(id string) (core.Workspace, error) {
	for _, w := range a.coreState.Layout.Workspaces {
		if w.ID != id {
			continue
		}
		if w.Machine != "" {
			return w, errors.New("Remote Git/worktree operations are not supported by this frontend; no local operation was attempted")
		}
		local := true
		for _, t := range w.Tabs {
			walkCorePanes(t.Root, func(p *core.Pane) { local = local && p.Terminal.CoreID == a.coreState.Layout.CoreID })
		}
		if !local {
			return w, errors.New("Workspace contains remote terminals; local Git operation refused")
		}
		if !filepath.IsAbs(w.CWD) {
			return w, errors.New("Workspace has no absolute Core working directory")
		}
		return w, nil
	}
	return core.Workspace{}, errors.New("Workspace not found")
}
func (a *App) gitRunner() gitCommand {
	if a.gitExec != nil {
		return a.gitExec
	}
	return runCoreGit
}
func (a *App) coreWorktree(id, value string, create bool) {
	s := a.coreSession
	w, err := a.localWorkspace(id)
	if err != nil || s == nil {
		a.cancelNavigation()
		a.coreBlocked = true
		a.coreSelect(nil)
		if err == nil {
			err = errors.New("Not connected to Core")
		}
		a.navigationNote = err.Error()
		a.invalidate()
		return
	}
	if gitTextPath(value) != nil {
		a.cancelNavigation()
		a.coreBlocked = true
		a.corePending = true
		a.coreSelect(nil)
		a.navigationNote = "Invalid worktree branch/path; terminal input was not sent"
		a.invalidate()
		return
	}
	a.coreNavigation++
	intent := a.coreNavigation
	n := a.beginCoreCapture("", true)
	origin := s.State()
	sourceValid := func() bool {
		state := s.State()
		if !state.Connected {
			return false
		}
		for _, current := range state.Layout.Workspaces {
			if current.ID == w.ID && current.CWD == w.CWD && current.Machine == "" && reflect.DeepEqual(current.Tabs, w.Tabs) {
				valid := true
				for _, tab := range w.Tabs {
					walkCorePanes(tab.Root, func(p *core.Pane) {
						valid = valid && state.Programs[p.Terminal.Address] == origin.Programs[p.Terminal.Address]
					})
				}
				return valid
			}
		}
		return false
	}
	a.corePending = true
	a.coreSelect(nil)
	run := a.gitRunner()
	go func() {
		parent := context.Background()
		if n != nil {
			parent = n.ctx
		}
		ctx, cancel := context.WithTimeout(parent, 5*time.Second)
		defer cancel()
		base, e := inspectRepository(ctx, run, s, w.CWD)
		if e != nil {
			a.failCoreCreation(s, intent, e.Error())
			return
		}
		path := value
		created := ""
		if create {
			a.mu.Lock()
			valid := sourceValid() && a.coreSession == s && a.coreNavigation == intent && ctx.Err() == nil
			a.mu.Unlock()
			if !valid {
				a.failCoreCreation(s, intent, "Worktree source/intent changed before creation")
				return
			}
			path, e = createCheckout(ctx, run, s, base, value)
			if e != nil {
				a.failCoreCreation(s, intent, e.Error())
				return
			}
			created = "Created checkout " + path + "; "
		} else if !filepath.IsAbs(path) {
			path = filepath.Join(base.root, path)
		}
		target, e := inspectRepository(ctx, run, s, filepath.Clean(path))
		if e == nil && target.common != base.common {
			e = errors.New("Checkout belongs to another repository")
		}
		if e != nil {
			a.failCoreCreation(s, intent, created+e.Error())
			return
		}
		a.mu.Lock()
		if a.coreSession != s || a.coreNavigation != intent || ctx.Err() != nil {
			a.mu.Unlock()
			if created != "" {
				a.coreNote(s, created+"navigation changed; checkout retained")
			}
			return
		}
		current, e := a.localWorkspace(id)
		if e == nil && (!sourceValid() || current.CWD != w.CWD || current.Repository != w.Repository) {
			e = errors.New("Workspace identity changed during Git operation")
		}
		if e != nil {
			a.mu.Unlock()
			a.failCoreCreation(s, intent, created+e.Error())
			return
		}
		a.coreApply(s)
		for _, dest := range a.coreState.Layout.Workspaces {
			if dest.Machine != "" || dest.CWD != target.root {
				continue
			}
			candidate := a.coreSelection.Clone()
			e = candidate.SelectWorkspace(&a.coreState.Layout, dest.ID)
			p := a.coreState.Layout.Pane(candidate.Pane)
			if e == nil {
				_, e = a.localWorkspace(dest.ID)
			}
			if e != nil || p == nil {
				a.mu.Unlock()
				a.failCoreCreation(s, intent, "Destination unavailable")
				return
			}
			pin, program := p.Terminal, s.State().Programs[p.Terminal.Address]
			original := origin.Layout.Pane(p.ID)
			if original == nil || original.Terminal != pin || origin.Programs[pin.Address] != program {
				a.mu.Unlock()
				a.failCoreCreation(s, intent, "Active worktree program/identity changed during operation")
				return
			}
			a.mu.Unlock()
			e = s.Edit(ctx, func(l *core.Layout) error {
				p := l.Pane(candidate.Pane)
				if p == nil || p.Terminal != pin {
					return errors.New("Active worktree pane changed")
				}
				for i := range l.Workspaces {
					w := &l.Workspaces[i]
					if w.ID == dest.ID && w.CWD == target.root && w.Machine == "" {
						applyRepository(w, target)
						return nil
					}
				}
				return errors.New("Destination workspace changed")
			})
			if e != nil {
				a.failCoreCreation(s, intent, e.Error())
				return
			}
			a.mu.Lock()
			if a.coreSession == s && a.coreNavigation == intent {
				a.coreApply(s)
				state := s.State()
				p := state.Layout.Pane(candidate.Pane)
				if p == nil || p.Terminal != pin || state.Programs[pin.Address] != program {
					a.mu.Unlock()
					a.failCoreCreation(s, intent, "Active worktree program changed")
					return
				}
				a.coreSelection = candidate
				if n != nil && a.coreCapture == n {
					n.pane, n.ref, n.program = p.ID, pin, program
					n.creating = false
					n.programs = nil
					n.existing = nil
				}
				a.corePending = false
				a.coreChrome()
				a.coreFocus()
				a.returnFocus = n == nil && a.dialog == nil && a.nativeDialog == nil
			}
			a.mu.Unlock()
			a.invalidate()
			return
		}
		if created != "" {
			a.coreOperationNote = created + "checkout retained unless separately removed"
		}
		a.coreRunCapture(s, intent, n, core.TerminalRunParams{CWD: core.Optional(target.root)}, created, func(l *core.Layout, p core.Pane, _ core.Terminal) error {
			sourceExists := false
			for _, source := range l.Workspaces {
				sourceExists = sourceExists || source.ID == w.ID && source.CWD == w.CWD && source.Machine == ""
				if source.CWD == target.root && source.Machine == "" {
					return errors.New("Checkout was added by another client; created terminal retained")
				}
			}
			if !sourceExists {
				return errors.New("Source workspace was removed")
			}
			l.AddWorkspace(filepath.Base(target.root), target.root, "", p)
			applyRepository(&l.Workspaces[len(l.Workspaces)-1], target)
			return nil
		})
		a.mu.Unlock()
	}()
}
func (a *App) RefreshRepository(id string) {
	s := a.coreSession
	w, err := a.localWorkspace(id)
	if err != nil || s == nil {
		if err != nil {
			a.navigationNote = err.Error()
		}
		a.invalidate()
		return
	}
	run := a.gitRunner()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		info, e := inspectRepository(ctx, run, s, w.CWD)
		if e == nil {
			e = s.Edit(ctx, func(l *core.Layout) error {
				for i := range l.Workspaces {
					dest := &l.Workspaces[i]
					if dest.ID == w.ID && dest.CWD == w.CWD && dest.Machine == "" {
						applyRepository(dest, info)
						return nil
					}
				}
				return errors.New("Workspace changed before Git metadata publication")
			})
		}
		if e != nil {
			a.coreNote(s, e.Error())
		}
	}()
}
func (a *App) coreRemoveWorktree(id string) {
	s := a.coreSession
	w, err := a.localWorkspace(id)
	if err != nil || s == nil {
		if err != nil {
			a.navigationNote = err.Error()
		}
		a.invalidate()
		return
	}
	if !w.Linked || w.Repository == "" {
		a.navigationNote = "Only linked checkouts can be removed"
		a.invalidate()
		return
	}
	run := a.gitRunner()
	a.confirmInWindow("Remove worktree checkout?", "Git must accept a non-forced removal. The branch is kept.", "Close", func() {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			info, e := inspectRepository(ctx, run, s, w.CWD)
			if e == nil && (!info.linked || info.common != w.Repository || info.root != w.CWD) {
				e = errors.New("Checkout identity changed; removal refused")
			}
			if e == nil {
				a.mu.Lock()
				current, err := a.localWorkspace(id)
				valid := err == nil && a.coreSession == s && current.CWD == w.CWD && current.Repository == w.Repository
				a.mu.Unlock()
				if !valid {
					e = errors.New("Workspace changed; removal refused")
				}
			}
			if e == nil {
				_, e = run(ctx, s, info.worktrees[0], []string{"worktree", "remove", "--", info.root})
			}
			if e != nil {
				a.coreNote(s, e.Error())
				return
			}
			e = s.Edit(ctx, func(l *core.Layout) error {
				for i := range l.Workspaces {
					if l.Workspaces[i].ID == w.ID && l.Workspaces[i].CWD == w.CWD {
						l.Workspaces[i].Repository = ""
						l.Workspaces[i].Linked = false
						l.Workspaces[i].Branch = ""
						l.Workspaces[i].AheadBehind = nil
						return nil
					}
				}
				return errors.New("Checkout removed; workspace changed before metadata update")
			})
			if e != nil {
				a.coreNote(s, fmt.Sprint("Checkout removed; ", e))
			} else {
				a.coreNote(s, "Checkout removed; branch and terminal records retained. Close terminals separately.")
			}
		}()
	}, nil)
}
