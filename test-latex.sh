#!/bin/bash
# Test script for LaTeX processor

echo "Testing LaTeX processor..."
echo ""
echo "Simple inline math: \$\\frac{1}{2}\$"
echo "Complex expression: \$\\nabla \\cdot E = \\frac{\\rho}{\\epsilon_0}\$"
echo "Matrix test: \$\\begin{bmatrix} 1 & 2 \\\\ 3 & 4 \\end{bmatrix}\$"
echo ""
echo "Testing split LaTeX (should buffer correctly):"
printf "Start: \$\\fra"
sleep 0.1
printf "c{3}{4}\$ end\n"
echo ""
echo "Multiple on one line: \$a^2\$ and \$b^2\$ make \$c^2\$"
echo ""
echo "Check the logs at:"
echo "  ~/.obsidian/plugins/laterm/logs/latex-processor-*.log"
echo "  ~/.obsidian/plugins/laterm/logs/terminal-write-*.log"