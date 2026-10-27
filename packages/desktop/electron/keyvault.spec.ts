/**
 * 密钥保险箱的用例（升级项 ①）。
 *
 * ★ 不 import electron：DPAPI 能力是注入的，这里用假实现验证语义。
 * ★ 重点盯四件事：格式前缀能自识别、遗留明文读得出来、加密不可用时不假装加密、
 *   系统加密抛异常时主进程不崩。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ENC_PREFIX,
  PLAIN_PREFIX,
  createElectronSecretCrypto,
  createSecretBox,
  needsSealing,
} from './keyvault';
import type { SafeStorageLike, SecretCrypto } from './keyvault';

const SECRET = 'sk-ant-api03-abcdefghijklmnop';

/** 假加密：可逆、明显不是原文（x 反转 + 前缀），够验证「密文里不含明文」。 */
function fakeCrypto(over: Partial<SecretCrypto> = {}): SecretCrypto {
  return {
    available: () => true,
    encrypt: (plain: string) => Buffer.from('x' + plain, 'utf8').toString('base64'),
    decrypt: (cipher: string) => {
      const plain = Buffer.from(cipher, 'base64').toString('utf8');
      if (!plain.startsWith('x')) throw new Error('不是本实现产的密文');
      return plain.slice(1);
    },
    ...over,
  };
}

describe('keyvault：seal / open 往返', () => {
  it('seal 出 enc:v1: 前缀，open 能原样还原，且密文串里不含明文', () => {
    const box = createSecretBox(fakeCrypto());
    const sealed = box.seal(SECRET);
    expect(sealed.startsWith(ENC_PREFIX)).toBe(true);
    expect(sealed).not.toContain(SECRET);
    expect(sealed.length).toBeGreaterThan(SECRET.length);
    expect(box.open(sealed)).toBe(SECRET);
  });

  it('★ open 认得无前缀的历史遗留明文（迁移读取路径）', () => {
    const box = createSecretBox(fakeCrypto());
    expect(box.open(SECRET)).toBe(SECRET);
  });

  it('open 认得 plain:v1: 前缀（降级值），并剥掉前缀', () => {
    const box = createSecretBox(fakeCrypto());
    expect(box.open(PLAIN_PREFIX + SECRET)).toBe(SECRET);
  });

  it('空值两头都安全：seal("") 出空串，open("") 出空串', () => {
    const box = createSecretBox(fakeCrypto());
    // 空 Key 就是「没配 Key」，不该在库里留一条空壳记录。
    expect(box.seal('')).toBe('');
    expect(box.open('')).toBe('');
  });
});

describe('keyvault：加密不可用时诚实降级', () => {
  it('available() 为 false → seal 产出 plain:v1: + 原文，不假装加密', () => {
    const encrypt = vi.fn((p: string) => Buffer.from(p).toString('base64'));
    const box = createSecretBox(fakeCrypto({ available: () => false, encrypt }));
    const sealed = box.seal(SECRET);
    expect(sealed).toBe(PLAIN_PREFIX + SECRET);
    expect(sealed.startsWith(ENC_PREFIX)).toBe(false);
    // 不可用就压根不该调 encrypt。
    expect(encrypt).not.toHaveBeenCalled();
    expect(box.open(sealed)).toBe(SECRET);
  });

  it('available() 自己抛异常时当作不可用（不让它把主进程带崩）', () => {
    const box = createSecretBox(
      fakeCrypto({
        available: () => {
          throw new Error('系统凭据服务异常');
        },
      }),
    );
    expect(box.seal(SECRET)).toBe(PLAIN_PREFIX + SECRET);
  });
});

describe('keyvault：系统加密抛异常时的降级', () => {
  it('encrypt 抛异常 → 降级为 plain:v1:（用户不丢 Key，也不崩）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const box = createSecretBox(
      fakeCrypto({
        encrypt: () => {
          throw new Error('CryptProtectData 失败');
        },
      }),
    );
    const sealed = box.seal(SECRET);
    expect(sealed).toBe(PLAIN_PREFIX + SECRET);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('encrypt 返回空串也降级（不写一条 enc:v1: 的空密文）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const box = createSecretBox(fakeCrypto({ encrypt: () => '' }));
    expect(box.seal(SECRET)).toBe(PLAIN_PREFIX + SECRET);
    warn.mockRestore();
  });

  it('decrypt 抛异常 → open 抛出（解不开不能返回伪造值）', () => {
    const box = createSecretBox(
      fakeCrypto({
        decrypt: () => {
          throw new Error('解密失败');
        },
      }),
    );
    expect(() => box.open(ENC_PREFIX + 'Zm9v')).toThrow('解密失败');
  });

  it('密文状态下系统加密不可用 → open 抛异常，而不是把密文当明文返回', () => {
    const box = createSecretBox(fakeCrypto({ available: () => false }));
    expect(() => box.open(ENC_PREFIX + 'Zm9v')).toThrow('系统加密不可用');
  });

  it('enc:v1: 后面是空串 → open 抛异常', () => {
    const box = createSecretBox(fakeCrypto());
    expect(() => box.open(ENC_PREFIX)).toThrow('密文为空');
  });
});

describe('keyvault：needsSealing（迁移判据）', () => {
  it('遗留明文与 plain:v1: 都要升级，密文与空值都不要', () => {
    expect(needsSealing(SECRET)).toBe(true);
    expect(needsSealing(PLAIN_PREFIX + SECRET)).toBe(true);
    expect(needsSealing(ENC_PREFIX + 'Zm9v')).toBe(false);
    expect(needsSealing('')).toBe(false);
    expect(needsSealing(undefined)).toBe(false);
    expect(needsSealing(null)).toBe(false);
    // 非字符串（历史脏数据）不该触发写回。
    expect(needsSealing(42)).toBe(false);
  });
});

/** 假 safeStorage：base64 往返，行为与 Electron 的三个方法对齐。 */
function fakeSafeStorage(over: Partial<SafeStorageLike> = {}): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from('dpapi:' + plain, 'utf8'),
    decryptString: (buf: Uint8Array) => {
      const text = Buffer.from(buf).toString('utf8');
      if (!text.startsWith('dpapi:')) throw new Error('不是本实现产的密文');
      return Buffer.from(text.slice('dpapi:'.length), 'utf8');
    },
    ...over,
  };
}

describe('keyvault：createElectronSecretCrypto（惰性注入 safeStorage）', () => {
  it('可用时：seal 走 safeStorage.encryptString 并以 base64 落库，open 还原', () => {
    const safeStorage = fakeSafeStorage();
    const box = createSecretBox(createElectronSecretCrypto(safeStorage));
    const sealed = box.seal(SECRET);
    expect(sealed.startsWith(ENC_PREFIX)).toBe(true);
    // 落库串是 base64 文本，不是 Buffer 的默认字符串化。
    expect(sealed.slice(ENC_PREFIX.length)).toBe(Buffer.from('dpapi:' + SECRET, 'utf8').toString('base64'));
    expect(sealed).not.toContain(SECRET);
    expect(box.open(sealed)).toBe(SECRET);
  });

  it('不可用时：seal 降级为 plain:v1:，且不调用 encryptString', () => {
    const encryptString = vi.fn((p: string) => Buffer.from(p));
    const box = createSecretBox(createElectronSecretCrypto(fakeSafeStorage({ isEncryptionAvailable: () => false, encryptString })));
    expect(box.seal(SECRET)).toBe(PLAIN_PREFIX + SECRET);
    expect(encryptString).not.toHaveBeenCalled();
  });

  it('isEncryptionAvailable 抛异常 → 当作不可用（Electron 在异常环境下会抛）', () => {
    const crypto = createElectronSecretCrypto(
      fakeSafeStorage({
        isEncryptionAvailable: () => {
          throw new Error('safeStorage 未就绪');
        },
      }),
    );
    expect(crypto.available()).toBe(false);
    expect(createSecretBox(crypto).seal(SECRET)).toBe(PLAIN_PREFIX + SECRET);
  });

  it('decryptString 抛异常 → 一路透传到 open（由调用方决定降级）', () => {
    const box = createSecretBox(
      createElectronSecretCrypto(
        fakeSafeStorage({
          decryptString: () => {
            throw new Error('DPAPI 解密失败');
          },
        }),
      ),
    );
    expect(() => box.open(ENC_PREFIX + Buffer.from('dpapi:' + SECRET).toString('base64'))).toThrow('DPAPI 解密失败');
  });

  it('encryptString 抛异常 → seal 降级为 plain:v1:（主进程不崩）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const box = createSecretBox(
      createElectronSecretCrypto(
        fakeSafeStorage({
          encryptString: () => {
            throw new Error('CryptProtectData 失败');
          },
        }),
      ),
    );
    expect(box.seal(SECRET)).toBe(PLAIN_PREFIX + SECRET);
    warn.mockRestore();
  });

  it('密文不是合法 base64 / 解出空 Buffer 时 open 抛异常', () => {
    const box = createSecretBox(createElectronSecretCrypto(fakeSafeStorage()));
    expect(() => box.open(ENC_PREFIX + '%%%')).toThrow();
  });
});
