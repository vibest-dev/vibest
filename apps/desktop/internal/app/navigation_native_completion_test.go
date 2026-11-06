package app

import (
	"fmt"
	"github.com/egoist/mygo/ui"
	"go/ast"
	"go/parser"
	"go/token"
	"testing"
)

func TestNavigationNativeOwnerSurvivesBackgroundCloseRequest(t *testing.T) {
	a, f := newCoreAppFixtureWith(t, coreActivitySeed)
	d := &dialog{}
	coreAppAct(a, func() {
		a.beginNativeDialog(d)
		a.ClosePane("a")
		if a.nativeDialog != d || a.dialog != nil {
			t.Fatal("close replaced native owner")
		}
		a.finishNativeDialog(d, false, "")
	})
	noCoreClose(t, f)
}

func TestNavigationNativePromptSourceUsesCompletionOnEveryResult(t *testing.T) {
	f, err := parser.ParseFile(token.NewFileSet(), "prompt_darwin.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"ask", "confirm"} {
		begin, finish := 0, 0
		for _, decl := range f.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Name.Name != name {
				continue
			}
			ast.Inspect(fn.Body, func(n ast.Node) bool {
				if call, ok := n.(*ast.CallExpr); ok {
					if sel, ok := call.Fun.(*ast.SelectorExpr); ok && sel.Sel.Name == "beginNativeDialog" {
						begin++
					}
				}
				if goStmt, ok := n.(*ast.GoStmt); ok {
					worker := goStmt.Call.Fun.(*ast.FuncLit)
					ast.Inspect(worker.Body, func(n ast.Node) bool {
						if _, ok := n.(*ast.ReturnStmt); ok {
							t.Error(name + " completion can return before shared dismissal")
						}
						if call, ok := n.(*ast.CallExpr); ok {
							if sel, ok := call.Fun.(*ast.SelectorExpr); ok && sel.Sel.Name == "finishNativeDialog" {
								finish++
							}
						}
						return true
					})
					return false
				}
				return true
			})
		}
		if begin != 1 || finish != 1 {
			t.Fatalf("%s begin=%d finish=%d", name, begin, finish)
		}
	}
}

func TestNavigationNativeCompletionResumesOnlyAcknowledgedDestination(t *testing.T) {
	for _, ready := range []bool{false, true} {
		for _, ok := range []bool{false, true} {
			t.Run(fmt.Sprint(ready, ok), func(t *testing.T) {
				a, f, tt, n, release := pendingCoreNavigation(t)
				tt.Type("held")
				ran, canceled := 0, 0
				d := &dialog{run: func(v string) {
					if v != "supplied" {
						t.Error("wrong supplied value")
					}
					ran++
				}, cancel: func() { canceled++ }}
				coreAppAct(a, func() { a.beginNativeDialog(d) })
				if n.events != nil || a.coreCapture != nil {
					t.Fatal("native opening retained content")
				}
				if ready {
					release()
					awaitCorePaintWithoutOwnership(t, a, tt, "c")
				}
				coreAppAct(a, func() { a.finishNativeDialog(d, ok, "supplied"); a.finishNativeDialog(d, ok, "supplied") })
				tt.Frame()
				if ok && (ran != 1 || canceled != 0) || !ok && (ran != 0 || canceled != 1) {
					t.Fatal("duplicate/missing callback", ran, canceled)
				}
				tt.TypeKeyNative(0, ui.KeyX, "x")
				if ready {
					wantCoreInput(t, f, "x")
				} else {
					noCoreData(t, f)
					release()
					awaitCorePaintWithoutOwnership(t, a, tt, "c")
					tt.Key(0, ui.KeyEnter)
				}
				noCoreData(t, f)
			})
		}
	}
}
func TestNavigationNativeCompletionCannotOverrideReplacement(t *testing.T) {
	for _, replacement := range []string{"before-completion", "callback-inline", "callback-native", "new-navigation"} {
		t.Run(replacement, func(t *testing.T) {
			a, f, tt, _, release := pendingCoreNavigation(t)
			oldRan := 0
			var next *dialog
			d := &dialog{run: func(string) {
				oldRan++
				if replacement == "callback-inline" {
					a.askInWindow("Replacement", "", false, func(string) {})
				}
				if replacement == "callback-native" {
					next = &dialog{}
					a.beginNativeDialog(next)
				}
			}}
			coreAppAct(a, func() { a.beginNativeDialog(d) })
			release()
			awaitCorePaintWithoutOwnership(t, a, tt, "c")
			coreAppAct(a, func() {
				if replacement == "before-completion" {
					a.askInWindow("Replacement", "", false, func(string) {})
				}
				if replacement == "new-navigation" {
					a.SelectTab("t1")
				}
				a.finishNativeDialog(d, true, "")
				if (replacement == "before-completion" || replacement == "new-navigation") && oldRan != 0 {
					t.Error("stale callback ran")
				}
				if replacement == "callback-native" && a.nativeDialog != next {
					t.Error("new native owner replaced")
				}
				if a.returnFocus {
					t.Error("old completion requested terminal focus")
				}
				if replacement != "new-navigation" && !a.coreBlocked {
					t.Error("replacement latch cleared")
				}
			})
			tt.Frame()
			if replacement == "before-completion" || replacement == "callback-inline" {
				tt.TypeKeyNative(0, ui.KeyX, "x")
				if a.dialog == nil || a.dialog.value != "x" || !tt.Focused("Replacement") {
					t.Fatal("replacement lost first x")
				}
			}
			noCoreData(t, f)
		})
	}
}
