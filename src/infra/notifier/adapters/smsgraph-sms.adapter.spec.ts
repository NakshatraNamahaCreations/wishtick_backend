import type { ConfigService } from '@nestjs/config';
import type { AppConfig } from 'src/config/configuration';
import { SmsGraphSmsAdapter } from './smsgraph-sms.adapter';

const TEMPLATE_ID = '1177179146524825640';

function adapter(): SmsGraphSmsAdapter {
  const sms = {
    senderId: 'WISHTK',
    smsgraph: {
      baseUrl: 'http://smsgraph.biz/api/SmsApi',
      userId: 'wishtick',
      password: 's3cret&pw',
      entityId: '1101234567890123096',
    },
  };
  const config = { get: () => sms } as unknown as ConfigService<AppConfig, true>;
  return new SmsGraphSmsAdapter(config);
}

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('SmsGraphSmsAdapter', () => {
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('sends the documented single-recipient request', async () => {
    fetchMock.mockResolvedValue(reply({ Response: { Message: 'Message ID : 56' }, Status: 'OK' }));

    await adapter().send({
      to: '+919876543210',
      body: 'Your Wishtick OTP is 4821. Do not share & stay safe',
      templateId: TEMPLATE_ID,
    });

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(`${url.origin}${url.pathname}`).toBe('http://smsgraph.biz/api/SmsApi/SendSingleApi');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      UserID: 'wishtick',
      Password: 's3cret&pw',
      SenderID: 'WISHTK',
      Phno: '9876543210',
      Msg: 'Your Wishtick OTP is 4821. Do not share & stay safe',
      EntityID: '1101234567890123096',
      TemplateID: TEMPLATE_ID,
      FlashMsg: '0',
    });
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('GET');
  });

  it('refuses to send without a DLT template ID', async () => {
    await expect(adapter().send({ to: '+919876543210', body: 'hi' })).rejects.toThrow(
      /template ID/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats a WARNING status as a failure and passes on the reason', async () => {
    fetchMock.mockResolvedValue(
      reply({ Response: { Message: 'Invalid UserID And Password!' }, Status: 'WARNING' }),
    );

    await expect(
      adapter().send({ to: '+919876543210', body: 'x', templateId: TEMPLATE_ID }),
    ).rejects.toThrow('SMSGraph refused the message: Invalid UserID And Password!');
  });

  it('fails on a non-2xx reply', async () => {
    fetchMock.mockResolvedValue(new Response('down', { status: 502, statusText: 'Bad Gateway' }));

    await expect(
      adapter().send({ to: '+919876543210', body: 'x', templateId: TEMPLATE_ID }),
    ).rejects.toThrow('SMSGraph returned 502 Bad Gateway');
  });

  it('never leaks the password when the gateway is unreachable', async () => {
    fetchMock.mockRejectedValue(
      new TypeError('fetch failed: http://smsgraph.biz/api/SmsApi/SendSingleApi?Password=s3cret'),
    );

    const err = await adapter()
      .send({ to: '+919876543210', body: 'x', templateId: TEMPLATE_ID })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('SMSGraph unreachable');
    expect((err as Error).message).not.toContain('s3cret');
  });

  describe('toIndianMobile', () => {
    it('strips the +91 country code', () => {
      expect(SmsGraphSmsAdapter.toIndianMobile('+919876543210')).toBe('9876543210');
      expect(SmsGraphSmsAdapter.toIndianMobile('919876543210')).toBe('9876543210');
      expect(SmsGraphSmsAdapter.toIndianMobile('9876543210')).toBe('9876543210');
    });

    it('refuses numbers outside India and malformed ones', () => {
      expect(() => SmsGraphSmsAdapter.toIndianMobile('+14155550123')).toThrow(/Indian/);
      expect(() => SmsGraphSmsAdapter.toIndianMobile('+911234567890')).toThrow(/Indian/);
      expect(() => SmsGraphSmsAdapter.toIndianMobile('+91987654321')).toThrow(/Indian/);
    });
  });
});
