/**
 * 本地密钥保险箱（升级项 ①：用 Windows DPAPI 加密落盘的 AI API Key）。
 *
 * ★ 为什么要有这一层：升级前 aiKey:<providerId> 是**明文**躺在 SQLite 里，
 *   任何能读 %APPDATA% 的进程/备份/同步盘都能直接拿走。Electron 的 safeStorage
 *   在 Windows 上底层就是 DPAPI(CryptProtectData)、当前用户作用域 —— 正好够用，
 *   所以不引 native 模块、不写 C# 助手。
 * ★ 本文件是**纯模块**：不 import electron、不 import node:fs。
 *   系统加密能力由调用方注入（main.ts 传 require('electron').safeStorage），
 *   所以本模块能在 vitest 的 node 环境里直接单测，也不会把 electron 拖进测试。
 * ★ 存储格式自识别（前缀决定怎么读，不靠外部元数据）：
 *     enc:v1:<base64>   已加密（本模块 seal 的产物）
 *     plain:v1:<原文>   诚实降级（系统加密不可用/加密抛异常时写这个，不假装加密）
 *     <无前缀>          历史遗留明文，读的时候当明文用，并顺手加密回写（见 ai.ts readKey）
 */

/** 密文前缀。版本号留在前缀里，将来换算法才能老库新库一起读。 */
export const ENC_PREFIX = 'enc:v1:';
/** 明文降级前缀。★ 有了它才能区分「故意存的明文」和「加密失败」，不会把降级悄悄当成加密。 */
export const PLAIN_PREFIX = 'plain:v1:';

/**
 * 系统加密能力的抽象（注入体）。
 *
 * ★ encrypt 返回的串会被直接拼在 ENC_PREFIX 后面，所以实现方必须自己把它变成
 *   可安全入库的文本（Electron 实现用 base64），不能带冒号/换行之外的怪东西更好。
 * ★ 两个方法都允许抛异常：系统凭据异常是真实存在的场景，降级由 createSecretBox 负责。
 */
export interface SecretCrypto {
  available(): boolean;
  /** 明文 → 可逆密文串（实现方负责编码成文本）。 */
  encrypt(plain: string): string;
  /** 密文串 → 明文；解不开必须抛。 */
  decrypt(cipher: string): string;
}

/** 上层只认这两个动作：存之前 seal，用之前 open。 */
export interface SecretBox {
  seal(plain: string): string;
  open(stored: string): string;
}

/**
 * 这个值还需要（重新）加密吗？
 *
 * ★ 判据是「不是密文」而不是「没有前缀」：plain:v1: 是加密不可用时的产物，
 *   等系统加密恢复可用后它也该被升级成 enc:v1:。
 */
export function needsSealing(stored: unknown): boolean {
  return typeof stored === 'string' && stored !== '' && !stored.startsWith(ENC_PREFIX);
}

export function createSecretBox(crypto: SecretCrypto): SecretBox {
  /** ★ available() 本身也可能抛（Electron 在某些环境下会），这里兜住：拿不准就当不可用。 */
  const isAvailable = (): boolean => {
    try {
      return crypto.available() === true;
    } catch {
      return false;
    }
  };

  return {
    seal(plain) {
      // 空 Key 就是「没配 Key」，别在库里留一条 plain:v1: 的空串。
      if (typeof plain !== 'string' || plain === '') return '';
      if (!isAvailable()) return PLAIN_PREFIX + plain;
      let out: string;
      try {
        out = crypto.encrypt(plain);
      } catch (e) {
        // ★ 加密失败不能让用户丢 Key，也不能假装成功：写 plain:v1: 并留痕。
        console.warn('[keyvault] 加密失败，降级为明文存储：' + String(e));
        return PLAIN_PREFIX + plain;
      }
      if (typeof out !== 'string' || out === '') {
        console.warn('[keyvault] 加密实现返回空串，降级为明文存储');
        return PLAIN_PREFIX + plain;
      }
      return ENC_PREFIX + out;
    },

    open(stored) {
      if (typeof stored !== 'string' || stored === '') return '';
      if (stored.startsWith(ENC_PREFIX)) {
        const body = stored.slice(ENC_PREFIX.length);
        if (body === '') throw new Error('密文为空');
        if (!isAvailable()) throw new Error('系统加密不可用，无法解密');
        // ★ 解不开就抛：交给调用方决定降级（ai.ts 那边当作「没有 Key」，不炸整个列表）。
        return crypto.decrypt(body);
      }
      if (stored.startsWith(PLAIN_PREFIX)) return stored.slice(PLAIN_PREFIX.length);
      // ★ 无前缀 = 历史遗留明文，原样返回（迁移读取路径）。
      return stored;
    },
  };
}

/**
 * Electron safeStorage 的最小面（只声明用得到的三个方法，避免顶层 import electron）。
 *
 * ★ 字节用 Uint8Array 而不是 Buffer：真实 safeStorage 给的是 Buffer（Buffer 是
 *   Uint8Array 的子类，结构上兼容），而测试替身不必依赖 node 的 Buffer 类型。
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Uint8Array;
  decryptString(encrypted: Uint8Array): Uint8Array;
}

/**
 * 基于 Electron safeStorage 的加密实现工厂。
 *
 * ★ 惰性注入：本模块不 import electron，由调用方传 require('electron').safeStorage。
 *   Windows 上 safeStorage 底层是 DPAPI（当前用户作用域），符合「仅本机本用户可解」的预期。
 * ★ encryptString / decryptString 都可能抛（系统凭据异常、跨用户拷贝的库），
 *   这里不吞：seal/open 各自决定降级方式，主进程不会因此崩。
 */
export function createElectronSecretCrypto(safeStorage: SafeStorageLike): SecretCrypto {
  return {
    available(): boolean {
      try {
        return safeStorage.isEncryptionAvailable() === true;
      } catch {
        return false;
      }
    },
    encrypt(plain: string): string {
      // ★ 用 base64 落库：密文串要能进 SQLite 的 TEXT 列（Buffer 直接 toString 会丢字节）。
      return Buffer.from(safeStorage.encryptString(plain)).toString('base64');
    },
    decrypt(cipher: string): string {
      const buf = Buffer.from(cipher, 'base64');
      if (buf.length === 0) throw new Error('密文解码后为空');
      return Buffer.from(safeStorage.decryptString(buf)).toString('utf8');
    },
  };
}
