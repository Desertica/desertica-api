import { UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CaptchaService } from './captcha.service';

const build = (secret: string) =>
  new CaptchaService({ get: () => secret } as unknown as ConfigService<
    never,
    true
  >);

afterEach(() => jest.restoreAllMocks());

describe('CaptchaService', () => {
  it('is skipped when no secret is configured', async () => {
    const spy = jest.spyOn(global, 'fetch');
    await expect(build('').verify(undefined)).resolves.toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it('requires a token when configured', async () => {
    await expect(build('s').verify(undefined)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it('accepts a successful verification and rejects failures and outages', async () => {
    const ok = { json: () => Promise.resolve({ success: true }) } as Response;
    const bad = { json: () => Promise.resolve({ success: false }) } as Response;
    const spy = jest.spyOn(global, 'fetch');
    spy.mockResolvedValueOnce(ok);
    await expect(build('s').verify('tok', '1.2.3.4')).resolves.toBeUndefined();
    spy.mockResolvedValueOnce(bad);
    await expect(build('s').verify('tok')).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    spy.mockRejectedValueOnce(new Error('network'));
    await expect(build('s').verify('tok')).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });
});
