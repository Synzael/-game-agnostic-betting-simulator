# Claude Code Configuration

## Project Overview
This is a Python-based project for quantitative finance and mathematical simulations. The codebase prioritizes numerical accuracy, performance, and reproducibility.

## Tech Stack
- **Language:** Python 3.11+
- **Core Libraries:** NumPy, SciPy, Pandas, SymPy
- **Visualization:** Matplotlib, Plotly
- **Testing:** pytest, hypothesis (property-based testing)
- **Type Checking:** mypy with strict mode

## Code Style & Conventions

### General
- Follow PEP 8 with a max line length of 88 (Black formatter)
- Use type hints for all function signatures
- Prefer NumPy vectorized operations over Python loops
- Use descriptive variable names (no single letters except for standard math notation like `x`, `t`, `n`)

### Docstrings
Use NumPy-style docstrings with mathematical context:
```python
def black_scholes_call(S: float, K: float, T: float, r: float, sigma: float) -> float:
    """
    Calculate European call option price using Black-Scholes formula.

    Parameters
    ----------
    S : float
        Current stock price
    K : float
        Strike price
    T : float
        Time to maturity (in years)
    r : float
        Risk-free interest rate (annualized)
    sigma : float
        Volatility (annualized)

    Returns
    -------
    float
        Call option price
    """
```

### Numerical Code
- Always set random seeds for reproducibility in simulations
- Document numerical stability concerns in comments
- Use `np.float64` for financial calculations; avoid `float32` unless memory-constrained
- Prefer `scipy.linalg` over `numpy.linalg` for better numerical stability
- Handle edge cases (division by zero, log of negative, etc.) explicitly

### File Structure