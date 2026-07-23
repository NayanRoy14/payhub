import { asyncHandler } from '../src/routes/asyncHandler';

describe('asyncHandler', () => {
  it('calls the wrapped handler with (req, res, next) and does not call next() on success', async () => {
    const inner = jest.fn().mockResolvedValue(undefined);
    const wrapped = asyncHandler(inner);
    const req = {} as any;
    const res = {} as any;
    const next = jest.fn();

    await wrapped(req, res, next);

    expect(inner).toHaveBeenCalledWith(req, res, next);
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards a rejected promise to next(err) instead of letting it become an unhandled rejection', async () => {
    const err = new Error('boom');
    const inner = jest.fn().mockRejectedValue(err);
    const wrapped = asyncHandler(inner);
    const next = jest.fn();

    await wrapped({} as any, {} as any, next);

    expect(next).toHaveBeenCalledWith(err);
  });

  it('forwards a synchronously thrown error to next(err) too', async () => {
    const err = new Error('sync boom');
    const inner = jest.fn(() => {
      throw err;
    });
    const wrapped = asyncHandler(inner as any);
    const next = jest.fn();

    await wrapped({} as any, {} as any, next);

    expect(next).toHaveBeenCalledWith(err);
  });
});
