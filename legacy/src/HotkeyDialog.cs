using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace Clipchan
{
    /// <summary>
    /// 热键设置对话框：点“录制”后直接按下想用的组合键即可录入。
    /// 与主面板同样保持圆角粉紫的二次元风格。
    /// </summary>
    internal sealed class HotkeyDialog : Form
    {
        private readonly Settings _settings;
        private readonly HotkeyWindow _msg;
        private readonly Settings _original;

        private TextBox _box;
        private Label _tip;
        private Button _btnRecord;
        private Button _btnSave;
        private Button _btnReset;
        private bool _recording;
        private Settings _draft;

        public bool Saved { get; private set; }

        public HotkeyDialog(Settings current, HotkeyWindow msg)
        {
            _settings = current;
            _msg = msg;
            _original = current;
            _draft = Clone(current);

            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.CenterScreen;
            Size = new Size(360, 268);
            BackColor = Theme.Canvas;
            DoubleBuffered = true;
            KeyPreview = true;
            ShowInTaskbar = false;

            var title = new Label();
            title.Text = "  ⚙ 热键设置";
            title.Font = Theme.Font(Theme.FontTitle, FontStyle.Bold);
            title.ForeColor = Theme.InkInvert;
            title.BackColor = Color.Transparent;
            title.AutoSize = false;
            title.Height = 34;
            title.Dock = DockStyle.Top;

            var label = new Label();
            label.Text = "当前组合：";
            label.Font = Theme.Font(9f, FontStyle.Regular);
            label.ForeColor = Theme.Ink;
            label.BackColor = Color.Transparent;
            label.AutoSize = true;
            label.SetBounds(22, 52, 90, 20);

            _box = new TextBox();
            _box.ReadOnly = true;
            _box.BorderStyle = BorderStyle.None;
            _box.Font = Theme.Font(Theme.FontTitle, FontStyle.Bold);
            _box.ForeColor = Theme.AccentDark;
            _box.BackColor = Theme.Field;
            _box.TextAlign = HorizontalAlignment.Center;
            _box.SetBounds(22, 76, 316, 26);
            _box.TabStop = false;
            _box.KeyDown += BoxKeyDown;

            _btnRecord = MakeButton("录制新组合", 22, 118, 148);
            _btnRecord.Click += delegate { StartRecording(); };

            _btnReset = MakeButton("恢复默认", 190, 118, 148);
            _btnReset.Click += delegate
            {
                _draft = new Settings();
                UpdateBox("已恢复默认组合", Theme.InkSoft);
            };

            _tip = new Label();
            _tip.Font = Theme.Font(8.5f, FontStyle.Regular);
            _tip.ForeColor = Theme.InkSoft;
            _tip.BackColor = Color.Transparent;
            _tip.AutoSize = false;
            _tip.SetBounds(22, 156, 316, 30);
            _tip.Text = "点「录制新组合」后，直接按下你想用的组合键。";

            _btnSave = MakeButton("保存", 22, 214, 148);
            _btnSave.BackColor = Theme.ButtonPrimary;
            _btnSave.Click += delegate { Save(); };

            var cancel = MakeButton("取消", 190, 214, 148);
            cancel.Click += delegate { Close(); };

            Controls.Add(label);
            Controls.Add(_box);
            Controls.Add(_btnRecord);
            Controls.Add(_btnReset);
            Controls.Add(_tip);
            Controls.Add(_btnSave);
            Controls.Add(cancel);
            Controls.Add(title);

            KeyDown += delegate(object s, KeyEventArgs e)
            {
                if (e.KeyCode == Keys.Escape && !_recording) Close();
            };

            ApplyRoundRegion();
            UpdateBox(null, Theme.InkSoft);
        }

        private static Settings Clone(Settings s)
        {
            return new Settings { Ctrl = s.Ctrl, Alt = s.Alt, Shift = s.Shift, Win = s.Win, Key = s.Key };
        }

        private Button MakeButton(string text, int x, int y, int w)
        {
            var b = new Button();
            b.Text = text;
            b.Font = Theme.Font(Theme.FontButton, FontStyle.Regular);
            b.FlatStyle = FlatStyle.Flat;
            b.FlatAppearance.BorderColor = Theme.Line;
            b.BackColor = Theme.Field;
            b.ForeColor = Theme.Ink;
            b.SetBounds(x, y, w, 30);
            b.TabStop = false;
            return b;
        }

        private void ApplyRoundRegion()
        {
            using (var p = Theme.RoundRect(new Rectangle(0, 0, Width, Height), Theme.Radius))
                Region = new Region(p);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            Theme.EnableSmoothing(g);

            g.FillRectangle(Theme.BrushCanvas, ClientRectangle);

            var head = new Rectangle(0, 0, Width, 34);
            using (var b = new LinearGradientBrush(head, Theme.Accent, Theme.Violet, 0f))
            using (var p = Theme.RoundRect(new Rectangle(0, 0, Width, 62), Theme.Radius))
            {
                Region old = g.Clip;
                g.SetClip(p);
                g.FillRectangle(b, head);
                g.Clip = old;
            }

            // 热键显示框：录制态用深色描边强提示
            using (var b = new SolidBrush(Theme.Field))
            using (var p = Theme.RoundRect(new Rectangle(18, 72, 324, 32), Theme.RadiusField))
            {
                g.FillPath(b, p);
                using (var pen = new Pen(_recording ? Theme.AccentDark : Theme.Line, _recording ? 1.8f : 1f))
                    g.DrawPath(pen, p);
            }

            using (var p = Theme.RoundRect(new Rectangle(0, 0, Width - 1, Height - 1), Theme.Radius))
            using (var pen = new Pen(Theme.WindowBorder, 1.4f))
                g.DrawPath(pen, p);

            base.OnPaint(e);
        }

        private void StartRecording()
        {
            _recording = true;
            _box.Text = "请按下组合键…";
            _box.ForeColor = Theme.InkSoft;
            _box.SelectionStart = 0;
            _box.SelectionLength = 0;
            _tip.Text = "正在录制…请按下想用的组合（需至少一个修饰键），Esc 取消。";
            _tip.ForeColor = Theme.AccentDark;
            _box.Focus();
            Invalidate();
        }

        private void BoxKeyDown(object sender, KeyEventArgs e)
        {
            if (!_recording)
            {
                // 未处于录制状态时，按任意键也直接开始录制，减少一次点击
                StartRecording();
                e.Handled = true;
                e.SuppressKeyPress = true;
                return;
            }

            if (e.KeyCode == Keys.Escape)
            {
                StopRecording("已取消录制", Theme.InkSoft);
                e.Handled = true; e.SuppressKeyPress = true;
                return;
            }

            Keys code = e.KeyCode;

            // 只按了修饰键：继续等待主键
            if (code == Keys.ControlKey || code == Keys.ShiftKey || code == Keys.Menu ||
                code == Keys.LWin || code == Keys.RWin)
            {
                e.Handled = true; e.SuppressKeyPress = true;
                return;
            }

            var candidate = new Settings();
            candidate.Ctrl = e.Control;
            candidate.Alt = e.Alt;
            candidate.Shift = e.Shift;
            candidate.Key = (int)code;

            if (!candidate.IsValid)
            {
                StopRecording("需要至少一个修饰键（Ctrl/Alt/Shift/Win）", Theme.Danger);
                e.Handled = true; e.SuppressKeyPress = true;
                return;
            }

            // 立即检测冲突，避免用户保存后才发现用不了
            if (!_msg.IsAvailable(candidate, _original))
            {
                StopRecording("该组合已被其他程序占用，请换一个", Theme.Danger);
                e.Handled = true; e.SuppressKeyPress = true;
                return;
            }

            _draft = candidate;
            StopRecording("可用！点「保存」生效", Theme.Success);
            e.Handled = true; e.SuppressKeyPress = true;
        }

        private void StopRecording(string tip, Color color)
        {
            _recording = false;
            _box.Text = _draft.Label;
            _box.ForeColor = Theme.AccentDark;
            _box.SelectionStart = 0;
            _box.SelectionLength = 0;   // 避免出现蓝色选中高亮
            _tip.Text = tip;
            _tip.ForeColor = color;
            Invalidate();
        }

        private void UpdateBox(string tip, Color color)
        {
            _box.Text = _draft.Label;
            _box.ForeColor = Theme.AccentDark;
            _box.SelectionStart = 0;
            _box.SelectionLength = 0;   // 避免出现蓝色选中高亮
            if (tip != null) { _tip.Text = tip; _tip.ForeColor = color; }
        }

        private void Save()
        {
            if (!_draft.IsValid)
            {
                _tip.Text = "组合无效，请重新录制";
                _tip.ForeColor = Theme.Danger;
                return;
            }

            if (!_msg.IsAvailable(_draft, _original))
            {
                _tip.Text = "该组合已被占用，请换一个";
                _tip.ForeColor = Theme.Danger;
                return;
            }

            _settings.Ctrl = _draft.Ctrl;
            _settings.Alt = _draft.Alt;
            _settings.Shift = _draft.Shift;
            _settings.Win = _draft.Win;
            _settings.Key = _draft.Key;
            _settings.Save();

            Saved = true;
            Close();
        }
    }
}
