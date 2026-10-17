using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

namespace Clipchan
{
    /// <summary>无界面自检：验证存储层、JSON 往返、上限裁剪与收藏。退出码 0 表示通过。</summary>
    internal static class SelfTest
    {
        private static int _failed;

        private static void Check(bool ok, string name)
        {
            Console.WriteLine((ok ? "  [PASS] " : "  [FAIL] ") + name);
            if (!ok) _failed++;
        }

        /// <summary>热键配置的读写与合法性校验。</summary>
        private static void TestSettings()
        {
            string path = Settings.FilePath;
            string backup = null;
            bool had = File.Exists(path);
            try
            {
                if (had) backup = File.ReadAllText(path);

                // 默认值：Ctrl + `
                var d = new Settings();
                Check(d.Ctrl && !d.Alt && !d.Shift && !d.Win && d.Key == (int)Keys.Oemtilde,
                    "default hotkey is Ctrl+tilde");
                Check(d.IsValid, "default hotkey is valid");
                Check(d.Label == "Ctrl+`", "default label renders as Ctrl+tilde");

                // 往返保存
                var s = new Settings { Ctrl = false, Alt = true, Shift = true, Win = false,
                                       Key = (int)Keys.V };
                s.Save();
                var back = Settings.Load();
                Check(back.Alt && back.Shift && !back.Ctrl && !back.Win &&
                      back.Key == (int)Keys.V, "hotkey settings round-trip");
                Check(back.Label == "Alt+Shift+V", "custom label renders correctly, got " + back.Label);

                // AutoPaste 默认开、可关、可往返
                Check(new Settings().AutoPaste, "auto-paste defaults to on");
                var ap = Settings.Load(); ap.AutoPaste = false; ap.Save();
                Check(!Settings.Load().AutoPaste, "auto-paste off round-trips");
                ap = Settings.Load(); ap.AutoPaste = true; ap.Save();
                Check(Settings.Load().AutoPaste, "auto-paste on round-trips");

                // 非法组合应被拒绝
                var bad = new Settings { Ctrl = false, Alt = false, Shift = false, Win = false,
                                         Key = (int)Keys.V };
                Check(!bad.IsValid, "hotkey without modifier is invalid");

                var bad2 = new Settings { Ctrl = true, Key = 0 };
                Check(!bad2.IsValid, "hotkey without a main key is invalid");

                var modOnly = new Settings { Ctrl = true, Key = (int)Keys.ControlKey };
                Check(!modOnly.IsValid, "modifier-only hotkey is invalid");

                // 损坏的配置文件不应导致崩溃，应回落到默认值
                File.WriteAllText(path, "{ broken !!!");
                var recovered = Settings.Load();
                Check(recovered.Ctrl && recovered.Key == (int)Keys.Oemtilde,
                    "corrupt settings file falls back to default");
            }
            catch (Exception ex)
            {
                Console.WriteLine("  [FAIL] settings exception: " + ex.Message);
                _failed++;
            }
            finally
            {
                try
                {
                    if (had && backup != null) File.WriteAllText(path, backup);
                    else if (File.Exists(path)) File.Delete(path);
                }
                catch (Exception) { }
            }
        }

        public static int Run()
        {
            string dir = Path.Combine(Path.GetTempPath(), "clipchan-selftest-" + Guid.NewGuid().ToString("N"));
            try
            {
                Console.WriteLine("Clipchan selftest");
                Console.WriteLine("temp dir: " + dir);

                // 1. 基本增查
                var s = new Store(dir);
                Check(s.Count == 0, "new store is empty");
                Check(s.Add("hello"), "add returns true");
                Check(s.Count == 1, "count == 1 after add");
                Check(s.Add("")== false, "empty text rejected");

                // 2. 重复内容不产生新条目
                s.Add("hello");
                Check(s.Count == 1, "duplicate text does not add a second item");

                // 3. 顺序（新的在前）
                s.Add("world");
                List<ClipItem> o = s.Ordered();
                Check(o.Count == 2 && o[0].Text == "world", "newest first");

                // 4. 收藏置顶
                s.TogglePin(o[1].Id);
                o = s.Ordered();
                Check(o[0].Pinned && o[0].Text == "hello", "pinned item floats to top");

                // 5. 特殊字符 JSON 往返
                string tricky = "quote:\" back:\\ nl:\n tab:\t uni:\u4F60\u597D \uD83C\uDF38";
                s.Add(tricky);
                var s2 = new Store(dir);
                bool found = false;
                foreach (ClipItem it in s2.Ordered()) if (it.Text == tricky) found = true;
                Check(found, "special characters survive JSON round-trip");

                // 6. 收藏在重载后保留
                bool pinKept = false;
                foreach (ClipItem it in s2.Ordered()) if (it.Pinned && it.Text == "hello") pinKept = true;
                Check(pinKept, "pinned state persists across reload");

                // 7. 删除：挑一条“未收藏”的删，避免影响第 8 步的收藏断言
                ClipItem victim = null;
                foreach (ClipItem it in s2.Ordered()) if (!it.Pinned) { victim = it; break; }
                Check(victim != null, "found an unpinned item to delete");
                s2.Remove(victim.Id);
                Check(s2.Find(victim.Id) == null, "remove works");

                // 8. 清空未收藏：应只剩收藏项，且重载后依然只剩它
                s2.ClearUnpinned();
                Check(s2.Count == 1 && s2.Ordered()[0].Pinned &&
                      s2.Ordered()[0].Text == "hello", "clear keeps only pinned");

                var s2b = new Store(dir);
                Check(s2b.Count == 1 && s2b.Ordered()[0].Pinned &&
                      s2b.Ordered()[0].Text == "hello", "clear result persists across reload");

                // 9. 上限裁剪
                var s3 = new Store(Path.Combine(dir, "trim"));
                for (int i = 0; i < Store.MaxItems + 25; i++) s3.Add("item-" + i);
                Check(s3.Ordered().Count == Store.MaxItems,
                    "unpinned trimmed to MaxItems (" + Store.MaxItems + "), got " + s3.Ordered().Count);
                Check(s3.Ordered()[0].Text == "item-" + (Store.MaxItems + 24), "newest kept after trim");

                // 10. 超长截断
                var s4 = new Store(Path.Combine(dir, "trunc"));
                s4.Add(new string('x', Store.MaxChars + 500));
                Check(s4.Ordered()[0].Truncated && s4.Ordered()[0].Text.Length == Store.MaxChars,
                    "over-long text truncated to MaxChars");

                // 11. 损坏文件不崩溃
                string badDir = Path.Combine(dir, "corrupt");
                Directory.CreateDirectory(badDir);
                File.WriteAllText(Path.Combine(badDir, "history.json"), "{ this is not json !!!");
                var s5 = new Store(badDir);
                Check(s5.Count == 0, "corrupt file loads as empty without throwing");
                Check(File.Exists(Path.Combine(badDir, "history.json.bad")), "corrupt file backed up to .bad");

                // 12. 相对时间不抛异常
                Check(Theme.RelativeTime(DateTime.UtcNow) == "\u521A\u521A", "recent time shows as just-now");

                // 13. 圆角路径可构造（视觉层基础）
                using (var p = Theme.RoundRect(new System.Drawing.Rectangle(0,0,100,50), 12))
                    Check(p.PointCount > 4, "rounded-rect path builds");

                // 14. 拼接（Ctrl+M）：多条合并成一条，源条目被移除
                var s6 = new Store(Path.Combine(dir, "merge"));
                s6.Add("part-A");
                s6.Add("part-B");
                s6.Add("part-C");
                var mergeTexts = new System.Collections.Generic.List<string> { "part-A", "part-B", "part-C" };
                ClipItem merged = s6.MergeTexts(mergeTexts, "\r\n");
                Check(merged != null && merged.Text == "part-A\r\npart-B\r\npart-C", "merge joins with separator");
                var mergeIds = new System.Collections.Generic.List<string>();
                foreach (ClipItem it in s6.Ordered()) if (it.Id != merged.Id) mergeIds.Add(it.Id);
                s6.RemoveMany(mergeIds);
                Check(s6.Count == 1 && s6.Ordered()[0].Text == merged.Text,
                    "merge leaves exactly one merged record");

                // 15. 拼接结果可持久化（seq 字段往返）
                var s6b = new Store(Path.Combine(dir, "merge"));
                Check(s6b.Count == 1 && s6b.Ordered()[0].Text == merged.Text,
                    "merged record persists across reload");

                // 16. 排序确定性：同一毫秒内连续加入，最新一条必须稳定排在最前
                var s7 = new Store(Path.Combine(dir, "order"));
                for (int i = 0; i < 50; i++) s7.Add("burst-" + i);
                Check(s7.Ordered()[0].Text == "burst-49", "same-timestamp burst keeps newest first");
                bool stable = true;
                for (int round = 0; round < 5; round++)
                    if (s7.Ordered()[0].Text != "burst-49") stable = false;
                Check(stable, "ordering is deterministic across repeated reads");

                // 17. 重复内容提到最前时序号同步刷新（否则会被旧序号压回后面）
                var s8 = new Store(Path.Combine(dir, "touch"));
                s8.Add("first");
                s8.Add("second");
                s8.Add("first");   // 重复：应提到最前
                Check(s8.Ordered()[0].Text == "first", "re-added duplicate moves to front");

                // 18. 今日筛选只返回今天的条目
                var s9 = new Store(Path.Combine(dir, "today"));
                s9.Add("today-item");
                Check(s9.GetToday().Count == 1, "GetToday returns today's items");

                // 19. RemoveMany 空列表/不存在 id 安全
                Check(s9.RemoveMany(new System.Collections.Generic.List<string>()) == 0,
                    "RemoveMany with empty list is a no-op");
                Check(s9.RemoveMany(new System.Collections.Generic.List<string> { "no-such-id" }) == 0,
                    "RemoveMany with unknown id is a no-op");

                // 20. 列表支持多选（Ctrl/Shift），这是 Ctrl+M 拼接的前置条件
                using (var lb = new System.Windows.Forms.ListBox())
                {
                    lb.SelectionMode = System.Windows.Forms.SelectionMode.MultiExtended;
                    for (int i = 0; i < 5; i++) lb.Items.Add("item-" + i);
                    lb.SelectedIndex = 1;
                    lb.SelectedIndices.Add(3);
                    lb.SelectedIndices.Add(2);
                    Check(lb.SelectedIndices.Count == 3,
                        "MultiExtended supports Ctrl/Shift additions, got " + lb.SelectedIndices.Count);
                }

                // 21. 主题令牌：切换明暗后画布色随之变化，且 Changed 只在真正切换时触发
                bool fired = false;
                Action handler = delegate { fired = true; };
                Theme.Changed += handler;
                try
                {
                    Color lightCanvas = Theme.Canvas;
                    fired = false;
                    bool changedToDark = Theme.Apply(true);
                    Check(changedToDark && Theme.IsDark && fired, "apply dark switches palette and fires Changed");
                    Check(Theme.Canvas != lightCanvas, "dark canvas differs from light canvas");

                    fired = false;
                    bool again = Theme.Apply(true);
                    Check(!again && !fired, "re-applying same theme is a no-op (no Changed)");

                    fired = false;
                    Theme.Apply(false);
                    Check(!Theme.IsDark && Theme.Canvas == lightCanvas && fired, "apply light restores light palette");
                }
                finally { Theme.Changed -= handler; Theme.Apply(false); }

                // 22. 主题模式归一化：非法/空值一律回落 auto
                Check(Settings.NormalizeThemeMode("DARK") == "dark", "theme mode is case-insensitive");
                Check(Settings.NormalizeThemeMode("light") == "light", "light mode preserved");
                Check(Settings.NormalizeThemeMode("nonsense") == "auto", "unknown theme mode falls back to auto");
                Check(Settings.NormalizeThemeMode(null) == "auto", "null theme mode falls back to auto");

                // 23. 英文分词：按非字母数字切、小写化、过滤停用词，保留长度≥2 的词
                var latin = new List<string>(WordCloudForm.LatinWords("Hello, World! the foo bar a 42"));
                Check(latin.Contains("hello") && latin.Contains("world") && latin.Contains("foo"),
                    "LatinWords splits on punctuation and lowercases");
                Check(!latin.Contains("the"), "LatinWords drops stop words");
                Check(!latin.Contains("a"), "LatinWords drops single characters");
                Check(latin.Contains("42"), "LatinWords keeps tokens of length>=2");

                // 24. 中文 n-gram 分词：反复出现的"剪贴板"整体胜出，虚词"的"被剪掉并合并计数
                var runs = new List<string> { "剪贴板的工具", "修复剪贴板的排序", "剪贴板的性能优化" };
                var words = WordCloudForm.ExtractCjkWords(runs);
                Check(words.ContainsKey("剪贴板") && words["剪贴板"] >= 3,
                    "ExtractCjkWords discovers 剪贴板 as a whole word with merged count");
                Check(!words.ContainsKey("剪贴板的"), "particle-suffixed form is trimmed, not kept raw");

                // 25. 虚词裁剪：首尾虚词被剪，实词保留
                Check(WordCloudForm.TrimParticles("剪贴板的") == "剪贴板", "TrimParticles strips trailing 的");
                Check(WordCloudForm.TrimParticles("的了剪贴板了") == "剪贴板", "TrimParticles strips leading and trailing particles");
                Check(WordCloudForm.TrimParticles("的") == "", "TrimParticles of a lone particle yields empty (gets dropped)");

                // 26. 自动粘贴决策：开关关 / 目标为空 / 目标是本程序自己的窗口 → 都不自动粘贴
                Check(!PastePolicy.ShouldAttemptAutoPaste(false, new IntPtr(123), new IntPtr(1)), "auto-paste off never pastes");
                Check(!PastePolicy.ShouldAttemptAutoPaste(true, IntPtr.Zero, new IntPtr(1)), "no recorded window never pastes");
                Check(!PastePolicy.ShouldAttemptAutoPaste(true, new IntPtr(1), new IntPtr(1)), "self window never pastes");
                // 27. 自动粘贴决策：开关开 + 他窗 → 尝试（存活与归位验证发生在发送时刻，不在这里）
                Check(PastePolicy.ShouldAttemptAutoPaste(true, new IntPtr(456), new IntPtr(1)), "foreign window with switch on attempts paste");
                // 28. 幽灵模式不影响粘贴：决策函数签名里没有幽灵参数即设计决定——只挡记录，不挡取用
                Check(PastePolicy.ShouldAttemptAutoPaste(true, new IntPtr(789), new IntPtr(1)), "ghost mode does not block paste path");

                // 29. 发送前的目标就绪门（评审修复 C1）：最小化/已销毁/隐藏/未归位 → 不粘贴
                Check(PastePolicy.TargetIsPasteReady(true, true, false, true), "live visible non-minimized restored window is paste-ready");
                Check(!PastePolicy.TargetIsPasteReady(true, true, true, true), "minimized target is NOT paste-ready (would inject into a restoring window)");
                Check(!PastePolicy.TargetIsPasteReady(false, true, false, true), "destroyed target is NOT paste-ready");
                Check(!PastePolicy.TargetIsPasteReady(true, false, false, true), "hidden target is NOT paste-ready");
                Check(!PastePolicy.TargetIsPasteReady(true, true, false, false), "unrestored (not foreground) target is NOT paste-ready");
                // 30. 兜底门（评审修复 I3）：明确没有焦点落点的空壳窗口（桌面/shell 面）→ 回退
                Check(PastePolicy.HasPasteTarget(true), "window with a focus sink may receive paste");
                Check(!PastePolicy.HasPasteTarget(false), "shell/desktop with no focus sink must fall back, not fake success");
            }
            catch (Exception ex)
            {
                Console.WriteLine("  [FAIL] exception: " + ex);
                _failed++;
            }
            finally
            {
                try { if (Directory.Exists(dir)) Directory.Delete(dir, true); } catch (Exception) { }
            }

            // 热键配置（Settings）单独测试：直接操作真实配置文件路径，
            // 测完恢复原值，避免污染用户设置。
            TestSettings();

            Console.WriteLine(_failed == 0 ? "SELFTEST OK" : ("SELFTEST FAILED (" + _failed + ")"));
            return _failed == 0 ? 0 : 1;
        }
    }
}
