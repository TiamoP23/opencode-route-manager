import { describe, expect, it } from 'vitest';
import { errorResult, RouteManagerError } from '../src/errors.js';

describe('RouteErrorCode', () => {
  it('INVALID_INPUT is a valid non-retryable code', () => {
    const err = new RouteManagerError('INVALID_INPUT', 'invalid input');
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.retryable).toBe(false);
  });
});

describe('errorResult', () => {
  it('preserves RouteManagerError code, message, and retryable', () => {
    const err = new RouteManagerError('ROUTE_NOT_FOUND', 'route xyz not found');
    const result = errorResult(err);
    expect(result).toEqual({ code: 'ROUTE_NOT_FOUND', message: 'route xyz not found', retryable: false });
  });

  it('preserves RouteManagerError message when empty string', () => {
    const err = new RouteManagerError('INTERNAL_ERROR', '');
    const result = errorResult(err);
    expect(result.message).toBe('');
  });

  it('sanitizes unknown Error message to fixed string', () => {
    const result = errorResult(new Error('secret db credentials'));
    expect(result).toEqual({ code: 'INTERNAL_ERROR', message: 'An internal error occurred', retryable: true });
  });

  it('sanitizes non-Error thrown value to fixed string', () => {
    const result = errorResult('some raw string');
    expect(result).toEqual({ code: 'INTERNAL_ERROR', message: 'An internal error occurred', retryable: true });
  });

  it('sanitizes null/undefined to fixed string', () => {
    expect(errorResult(null)).toEqual({ code: 'INTERNAL_ERROR', message: 'An internal error occurred', retryable: true });
    expect(errorResult(undefined)).toEqual({ code: 'INTERNAL_ERROR', message: 'An internal error occurred', retryable: true });
  });

  it('sanitizes objects/numbers/booleans to fixed string', () => {
    expect(errorResult(42)).toEqual({ code: 'INTERNAL_ERROR', message: 'An internal error occurred', retryable: true });
    expect(errorResult(false)).toEqual({ code: 'INTERNAL_ERROR', message: 'An internal error occurred', retryable: true });
    expect(errorResult({ some: 'data' })).toEqual({ code: 'INTERNAL_ERROR', message: 'An internal error occurred', retryable: true });
  });
});
