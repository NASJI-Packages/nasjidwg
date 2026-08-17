;; nasjidwg — hatch pattern library, written for the test suite.
;;
;; Four patterns chosen to exercise every part of the .pat grammar: a
;; solid-ruled fill with no dashes, a dashed pattern with gaps, a crossing
;; pattern built from several definition lines at different angles, and a
;; dense one whose lines carry a non-zero base point. Written by hand from
;; the format's own rules — a pattern is a name, a description, and one
;; line per family: angle, base x,y, offset x,y, then the dash lengths
;; (negative for a gap).

*NASJI_RULE, Plain horizontal rules
0, 0,0, 0,3

*NASJI_DASH, Dashed rules with an even gap
0, 0,0, 0,4, 2,-2

;; A grid: two families, ninety degrees apart, sharing one spacing.
*NASJI_GRID, Square grid
0, 0,0, 0,5
90, 0,0, 0,5

;; Offsets shift each successive line along its own direction, which is
;; what makes a running-bond course out of a single family.
*NASJI_BOND, Running bond brickwork
0, 0,0, 0,4
90, 0,0, 4,4, 4,-4
90, 4,2, 4,4, 4,-4
