// Damped spring for one number. While `held`, the value belongs to the
// pointer and the spring only remembers the velocity it is handed on release.
export class Spring {
  value: number;
  target: number;
  velocity = 0;
  held = false;

  constructor(
    value: number,
    public stiffness = 170,
    public damping = 15,
    public min = -Infinity, // a hard stop: the value rests against it instead of passing
    public max = Infinity, // the same, from above
  ) {
    this.value = value;
    this.target = value;
  }

  step(dt: number) {
    if (this.held) return;
    let remaining = Math.min(dt, 1 / 30);
    while (remaining > 0) {
      const h = Math.min(remaining, 1 / 240);
      const force = -this.stiffness * (this.value - this.target) - this.damping * this.velocity;
      this.velocity += force * h;
      this.value += this.velocity * h;
      if (this.value < this.min) {
        this.value = this.min;
        this.velocity = Math.max(this.velocity, 0);
      }
      if (this.value > this.max) {
        this.value = this.max;
        this.velocity = Math.min(this.velocity, 0);
      }
      remaining -= h;
    }
    if (Math.abs(this.value - this.target) < 1e-4 && Math.abs(this.velocity) < 1e-3) {
      this.value = this.target;
      this.velocity = 0;
    }
  }
}
